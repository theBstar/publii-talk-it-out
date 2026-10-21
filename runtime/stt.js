/*
 * Talk It Out — speech-to-text engines.
 *
 * local: Whisper running on this machine through transformers.js (WebGPU when
 *        available, WebAssembly otherwise). Audio never leaves the computer.
 *        The model is downloaded once from Hugging Face and cached.
 * cloud: any OpenAI-compatible /audio/transcriptions endpoint (OpenAI, Groq, a
 *        local whisper.cpp server, ...). Billed by that provider per minute.
 */
(function (root) {
    'use strict';

    const NS = root.TalkItOutNS;
    const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';

    // Shared by the worker and the main-thread fallback
    const ENGINE_SOURCE = `
        let asr = null;
        let loadedKey = null;
        let loading = null;

        async function pickDevice () {
            try {
                if (self.navigator && self.navigator.gpu && await self.navigator.gpu.requestAdapter()) {
                    return 'webgpu';
                }
            } catch (e) {}

            return 'wasm';
        }

        async function ensureModel (transformers, model, report) {
            if (asr && loadedKey === model) {
                return asr;
            }

            if (loading && loadedKey === model) {
                return loading;
            }

            loadedKey = model;
            transformers.env.allowLocalModels = false;

            if (typeof caches === 'undefined') {
                transformers.env.useBrowserCache = false;
            }

            let files = {};
            let device = await pickDevice();
            let dtype = device === 'webgpu'
                ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
                : 'q8';

            loading = transformers.pipeline('automatic-speech-recognition', model, {
                device,
                dtype,
                progress_callback: info => {
                    if (info.status === 'progress' && info.file) {
                        files[info.file] = { loaded: info.loaded || 0, total: info.total || 0 };
                        let loaded = 0, total = 0;
                        Object.values(files).forEach(f => { loaded += f.loaded; total += f.total; });
                        report({ status: 'downloading', progress: total ? loaded / total : 0, loaded, total, device });
                    }
                }
            }).then(pipe => {
                asr = pipe;
                report({ status: 'ready', device });
                return pipe;
            }).catch(error => {
                asr = null;
                loadedKey = null;
                loading = null;
                throw error;
            });

            return loading;
        }

        async function runTranscription (transformers, data, report) {
            let pipe = await ensureModel(transformers, data.model, report);
            let multilingual = !/\\.en$/.test(data.model);
            let options = multilingual
                ? { task: 'transcribe', language: data.language || null }
                : {};
            let output = await pipe(data.audio, options);
            return (output && output.text ? output.text : '').trim();
        }
    `;

    const WORKER_SOURCE = `
        import * as transformers from '${TRANSFORMERS_URL}';
        ${ENGINE_SOURCE}

        self.onmessage = async event => {
            let data = event.data;
            let report = info => self.postMessage({ type: 'progress', info });

            try {
                if (data.type === 'load') {
                    await ensureModel(transformers, data.model, report);
                    self.postMessage({ id: data.id, type: 'done' });
                } else if (data.type === 'transcribe') {
                    let text = await runTranscription(transformers, data, report);
                    self.postMessage({ id: data.id, type: 'done', text });
                }
            } catch (error) {
                self.postMessage({ id: data.id, type: 'error', error: String((error && error.message) || error) });
            }
        };

        self.postMessage({ type: 'booted' });
    `;

    class LocalWhisper {
        constructor (getSettings, onProgress) {
            this.getSettings = getSettings;
            this.onProgress = onProgress || (() => {});
            this.worker = null;
            this.inline = null;
            this.pending = new Map();
            this.nextId = 1;
            this.booting = null;
        }

        _bootWorker () {
            if (this.booting) {
                return this.booting;
            }

            this.booting = new Promise((resolve, reject) => {
                let url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
                let worker;

                try {
                    worker = new Worker(url, { type: 'module' });
                } catch (error) {
                    reject(error);
                    return;
                }

                let timer = setTimeout(() => reject(new Error('Speech worker did not start')), 20000);

                worker.onerror = event => {
                    clearTimeout(timer);
                    reject(new Error(event.message || 'Speech worker failed to load'));
                };

                worker.onmessage = event => {
                    let message = event.data;

                    if (message.type === 'booted') {
                        clearTimeout(timer);
                        this.worker = worker;
                        resolve('worker');
                        return;
                    }

                    if (message.type === 'progress') {
                        this.onProgress(message.info);
                        return;
                    }

                    let job = this.pending.get(message.id);

                    if (job) {
                        this.pending.delete(message.id);
                        message.type === 'error' ? job.reject(new Error(message.error)) : job.resolve(message.text);
                    }
                };
            }).catch(async error => {
                // Some environments refuse module workers from blob: URLs; run on the main thread instead
                console.warn('[Talk It Out] Speech worker unavailable, using main thread:', error);
                let transformers = await import(TRANSFORMERS_URL);
                let factory = new Function('transformers', ENGINE_SOURCE + '; return { ensureModel, runTranscription };');
                this.inline = { transformers, engine: factory() };
                return 'inline';
            });

            return this.booting;
        }

        async _call (type, payload, transfer) {
            await this._bootWorker();

            if (this.inline) {
                let { transformers, engine } = this.inline;

                if (type === 'load') {
                    await engine.ensureModel(transformers, payload.model, this.onProgress);
                    return '';
                }

                return engine.runTranscription(transformers, payload, this.onProgress);
            }

            let id = this.nextId++;

            return new Promise((resolve, reject) => {
                this.pending.set(id, { resolve, reject });
                this.worker.postMessage(Object.assign({ id, type }, payload), transfer || []);
            });
        }

        load () {
            let settings = this.getSettings();
            return this._call('load', { model: settings.stt.localModel });
        }

        transcribe (pcm) {
            let settings = this.getSettings();
            let audio = new Float32Array(pcm);

            return this._call('transcribe', {
                model: settings.stt.localModel,
                language: settings.stt.language,
                audio
            }, [audio.buffer]);
        }
    }

    class CloudTranscriber {
        constructor (getSettings) {
            this.getSettings = getSettings;
        }

        load () {
            let settings = this.getSettings();

            if (!settings.stt.cloudApiKey) {
                return Promise.reject(new Error('Add an API key for cloud transcription in Talk It Out settings.'));
            }

            return Promise.resolve();
        }

        async transcribe (pcm, context) {
            let settings = this.getSettings().stt;
            let form = new FormData();
            form.append('file', NS.audio.encodeWav(pcm), 'speech.wav');
            form.append('model', settings.cloudModel);
            form.append('response_format', 'json');

            if (settings.language) {
                form.append('language', settings.language);
            }

            // Recent text helps with names and continuity
            if (context && context.prompt) {
                form.append('prompt', context.prompt.slice(-400));
            }

            let response = await fetch(settings.cloudBaseUrl.replace(/\/+$/, '') + '/audio/transcriptions', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + settings.cloudApiKey },
                body: form
            });

            if (response.status === 401 || response.status === 403) {
                throw new Error('The transcription service rejected the API key.');
            }

            if (!response.ok) {
                let detail = '';

                try { detail = (await response.json()).error.message; } catch (e) {}

                throw new Error('Transcription failed (' + response.status + ')' + (detail ? ': ' + detail : ''));
            }

            let result = await response.json();
            return String(result.text || '').trim();
        }
    }

    function createEngine (getSettings, onProgress) {
        return getSettings().stt.provider === 'cloud'
            ? new CloudTranscriber(getSettings)
            : new LocalWhisper(getSettings, onProgress);
    }

    NS.stt = { createEngine, LocalWhisper, CloudTranscriber, TRANSFORMERS_URL };
})(window);
