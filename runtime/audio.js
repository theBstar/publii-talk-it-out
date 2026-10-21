/*
 * Talk It Out — microphone capture and utterance detection.
 *
 * Splits the mic stream into utterances using an adaptive energy threshold:
 * speech starts when the level rises well above the measured noise floor and
 * ends after `silenceMs` of quiet. Each utterance is delivered as 16 kHz mono
 * Float32 PCM, which is what Whisper expects.
 */
(function (root) {
    'use strict';

    const TARGET_RATE = 16000;
    const FRAME_SIZE = 1024;
    const PRE_ROLL_MS = 300;
    const MIN_SPEECH_MS = 250;
    const MAX_UTTERANCE_MS = 28000;   // Whisper's window is 30 s

    // Box-filter decimation: good enough for speech, no dependencies
    function resample (input, fromRate) {
        if (fromRate === TARGET_RATE) {
            return input;
        }

        let ratio = fromRate / TARGET_RATE;
        let length = Math.floor(input.length / ratio);
        let output = new Float32Array(length);

        for (let i = 0; i < length; i++) {
            let start = Math.floor(i * ratio);
            let end = Math.min(Math.floor((i + 1) * ratio), input.length);
            let sum = 0;

            for (let j = start; j < end; j++) {
                sum += input[j];
            }

            output[i] = sum / Math.max(end - start, 1);
        }

        return output;
    }

    function concat (chunks) {
        let length = chunks.reduce((total, chunk) => total + chunk.length, 0);
        let output = new Float32Array(length);
        let offset = 0;

        chunks.forEach(chunk => {
            output.set(chunk, offset);
            offset += chunk.length;
        });

        return output;
    }

    class Recorder {
        /**
         * @param {object} options
         *   onUtterance(Float32Array pcm16k, durationSeconds)
         *   onLevel(level 0..1, isSpeech)
         *   onSpeechStart()
         *   silenceMs, sensitivity (0..1)
         */
        constructor (options) {
            this.options = Object.assign({ silenceMs: 800, sensitivity: 0.5 }, options);
            this.running = false;
            this.muted = false;
        }

        async start () {
            if (this.running) {
                return;
            }

            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            this.context = new AudioContext();
            this.sampleRate = this.context.sampleRate;
            this.source = this.context.createMediaStreamSource(this.stream);
            // ScriptProcessorNode is deprecated but needs no separate worklet file,
            // which matters when loading from file:// inside Publii
            this.processor = this.context.createScriptProcessor(FRAME_SIZE, 1, 1);
            this.processor.onaudioprocess = event => this._frame(event.inputBuffer.getChannelData(0));
            this.source.connect(this.processor);
            this.processor.connect(this.context.destination);

            this.frameMs = FRAME_SIZE / this.sampleRate * 1000;
            this.noiseFloor = 0.004;
            this.calibrationFrames = Math.ceil(400 / this.frameMs);
            this.preRoll = [];
            this.chunks = [];
            this.inSpeech = false;
            this.speechFrames = 0;
            this.silenceFrames = 0;
            this.loudFrames = 0;
            this.running = true;
        }

        stop () {
            if (!this.running) {
                return;
            }

            this.running = false;

            if (this.inSpeech) {
                this._emit();
            }

            try { this.processor.disconnect(); } catch (e) {}
            try { this.source.disconnect(); } catch (e) {}
            this.stream.getTracks().forEach(track => track.stop());
            this.context.close();
        }

        // Ignore input (e.g. while speaking feedback aloud)
        setMuted (muted) {
            this.muted = muted;

            if (muted && this.inSpeech) {
                this._reset();
            }
        }

        updateOptions (options) {
            Object.assign(this.options, options);
        }

        _threshold () {
            let sensitivity = Math.min(Math.max(this.options.sensitivity, 0), 1);
            let multiplier = 5 - sensitivity * 3.2;      // 5x (low) .. 1.8x (high) above noise
            return Math.max(this.noiseFloor * multiplier, 0.006 - sensitivity * 0.003);
        }

        _frame (samples) {
            if (!this.running) {
                return;
            }

            let frame = new Float32Array(samples);
            let sum = 0;

            for (let i = 0; i < frame.length; i++) {
                sum += frame[i] * frame[i];
            }

            let rms = Math.sqrt(sum / frame.length);

            if (this.calibrationFrames > 0) {
                this.calibrationFrames--;
                this.noiseFloor = this.noiseFloor * 0.7 + rms * 0.3;
                return;
            }

            let threshold = this._threshold();
            let loud = !this.muted && rms > threshold;

            if (this.options.onLevel) {
                this.options.onLevel(Math.min(rms / (threshold * 4), 1), this.inSpeech);
            }

            if (!this.inSpeech) {
                // Track the noise floor only while nobody is talking
                if (!loud) {
                    this.noiseFloor = this.noiseFloor * 0.98 + Math.min(rms, threshold) * 0.02;
                }

                this.preRoll.push(frame);

                if (this.preRoll.length > Math.ceil(PRE_ROLL_MS / this.frameMs)) {
                    this.preRoll.shift();
                }

                this.loudFrames = loud ? this.loudFrames + 1 : 0;

                if (this.loudFrames >= 3) {
                    this.inSpeech = true;
                    this.chunks = this.preRoll.slice();
                    this.preRoll = [];
                    this.speechFrames = this.loudFrames;
                    this.silenceFrames = 0;

                    if (this.options.onSpeechStart) {
                        this.options.onSpeechStart();
                    }
                }

                return;
            }

            this.chunks.push(frame);

            if (rms > threshold * 0.8) {
                this.speechFrames++;
                this.silenceFrames = 0;
            } else {
                this.silenceFrames++;
            }

            let silenceMs = this.silenceFrames * this.frameMs;
            let totalMs = this.chunks.length * this.frameMs;

            if (silenceMs >= this.options.silenceMs || totalMs >= MAX_UTTERANCE_MS) {
                this._emit();
            }
        }

        _emit () {
            let speechMs = this.speechFrames * this.frameMs;
            let chunks = this.chunks;
            this._reset();

            if (speechMs < MIN_SPEECH_MS || !this.options.onUtterance) {
                return;
            }

            let pcm = resample(concat(chunks), this.sampleRate);
            this.options.onUtterance(pcm, pcm.length / TARGET_RATE);
        }

        _reset () {
            this.inSpeech = false;
            this.chunks = [];
            this.preRoll = [];
            this.speechFrames = 0;
            this.silenceFrames = 0;
            this.loudFrames = 0;
        }
    }

    // 16-bit PCM WAV for cloud transcription APIs
    function encodeWav (pcm, sampleRate = TARGET_RATE) {
        let buffer = new ArrayBuffer(44 + pcm.length * 2);
        let view = new DataView(buffer);
        let writeString = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };

        writeString(0, 'RIFF');
        view.setUint32(4, 36 + pcm.length * 2, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeString(36, 'data');
        view.setUint32(40, pcm.length * 2, true);

        for (let i = 0; i < pcm.length; i++) {
            let sample = Math.max(-1, Math.min(1, pcm[i]));
            view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        }

        return new Blob([buffer], { type: 'audio/wav' });
    }

    root.TalkItOutNS = root.TalkItOutNS || {};
    root.TalkItOutNS.audio = { Recorder, encodeWav, resample, TARGET_RATE };
})(window);
