/*
 * Talk It Out — settings page (Publii custom plugin settings view).
 *
 * Runs inside an iframe in Publii's Tools → Plugins screen. Opening it also
 * starts the Talk It Out runtime in Publii's main window for this session.
 */
(function () {
    'use strict';

    const NS = window.TalkItOutNS;
    const S = NS.settings;
    const VERSION = '0.1.3';
    const parentWindow = window.parent;
    const pluginBase = new URL('../', window.location.href).href;
    const $ = selector => document.querySelector(selector);

    let settings = S.load();

    // Match Publii's light/dark theme straight away (Publii also sets it on load)
    try {
        let theme = parentWindow.document.documentElement.getAttribute('data-theme');

        if (theme) {
            document.documentElement.setAttribute('data-theme', theme);
        }
    } catch (e) {}

    /* ---------------- runtime in the main window ---------------- */

    function ensureRuntime () {
        if (parentWindow.TalkItOut) {
            return Promise.resolve(parentWindow.TalkItOut);
        }

        return new Promise((resolve, reject) => {
            let timer = setTimeout(() => reject(new Error('Talk It Out did not start. See View → Toggle Developer Tools for details.')), 20000);

            parentWindow.addEventListener('talk-it-out-ready', () => {
                clearTimeout(timer);
                resolve(parentWindow.TalkItOut);
            }, { once: true });

            if (!parentWindow.__talkItOutLoading) {
                // Created by the parent document so it runs in Publii's window
                let script = parentWindow.document.createElement('script');
                script.src = pluginBase + 'runtime/loader.js?v=' + VERSION;
                parentWindow.document.head.appendChild(script);
            }
        });
    }

    const runtimeReady = ensureRuntime();

    runtimeReady.then(api => {
        let pill = $('#runtime-status');
        let compat = api.compatibility();
        pill.dataset.state = compat.tested ? 'ready' : 'warn';
        pill.textContent = compat.tested
            ? 'Active in editors · v' + api.version
            : 'Active · untested on Publii ' + compat.publii;
        pill.title = compat.tested ? '' : 'Tested with Publii ' + compat.testedWith.join(', ') + '. Please report anything that misbehaves.';
    }).catch(error => {
        let pill = $('#runtime-status');
        pill.dataset.state = 'error';
        pill.textContent = 'Not running';
        pill.title = error.message;
    });

    /* ---------------- settings binding ---------------- */

    function getPath (object, path) {
        return path.split('.').reduce((value, key) => (value ? value[key] : undefined), object);
    }

    function patchFor (path, value) {
        let keys = path.split('.');
        let patch = {};
        let cursor = patch;

        keys.forEach((key, i) => {
            if (i === keys.length - 1) {
                cursor[key] = value;
            } else {
                cursor[key] = {};
                cursor = cursor[key];
            }
        });

        return patch;
    }

    let savedTimer = null;

    function persist (path, value) {
        settings = S.update(patchFor(path, value));
        refreshConditional();
        refreshCostHint();

        // The storage event covers this too; the direct call makes it immediate
        if (parentWindow.TalkItOut) {
            parentWindow.TalkItOut.settingsChanged();
        }

        let saved = $('#saved');
        saved.textContent = 'Saved';
        saved.classList.add('show');
        clearTimeout(savedTimer);
        savedTimer = setTimeout(() => saved.classList.remove('show'), 1400);
    }

    function updateOutput (input) {
        let outputId = input.dataset.output;

        if (!outputId) {
            return;
        }

        let value = Number(input.value);
        let text = input.dataset.unit === 'ms'
            ? (value / 1000).toFixed(1) + ' s'
            : Math.round(value * 100) + '%';
        document.getElementById(outputId).textContent = text;
    }

    document.querySelectorAll('[data-setting]').forEach(input => {
        let path = input.dataset.setting;
        let value = getPath(settings, path);

        if (input.type === 'radio') {
            input.checked = input.value === value;
        } else if (input.type === 'checkbox') {
            input.checked = !!value;
        } else {
            input.value = value === undefined || value === null ? '' : value;
        }

        updateOutput(input);

        let handler = () => {
            let next;

            if (input.type === 'checkbox') next = input.checked;
            else if (input.type === 'range') next = Number(input.value);
            else if (input.type === 'radio') { if (!input.checked) return; next = input.value; }
            else next = input.value.trim();

            updateOutput(input);
            persist(path, next);
        };

        input.addEventListener(input.tagName === 'SELECT' || input.type === 'radio' || input.type === 'checkbox' ? 'change' : 'input', handler);
    });

    // data-show-when="path=value" or "path!~text" (value does not contain text)
    function refreshConditional () {
        document.querySelectorAll('[data-show-when]').forEach(el => {
            let rule = el.dataset.showWhen;
            let visible;
            let notContains = rule.match(/^(.+)!~(.+)$/);

            if (notContains) {
                visible = String(getPath(settings, notContains[1]) || '').indexOf(notContains[2]) === -1;
            } else {
                let [path, expected] = rule.split('=');
                visible = String(getPath(settings, path)) === expected;
            }

            el.hidden = !visible;
        });
    }

    function refreshCostHint () {
        let model = settings.ai.model;
        // Rough sizes: a ~1,000-word article drafted from ~1,300 spoken words,
        // and one edit on a ~1,500-word post. Output includes model reasoning.
        let draft = S.estimateCost(model, 2200, 3000);
        let edit = S.estimateCost(model, 2600, 600);
        let format = cost => cost < 0.01 ? '<$0.01' : '$' + cost.toFixed(2);

        $('#cost-hint').textContent = draft === null
            ? ''
            : 'Billed to your key. Roughly ' + format(draft) + ' to draft a 1,000-word article and ' + format(edit) + ' per voice edit. The editor panel shows a running total.';
    }

    refreshConditional();
    refreshCostHint();

    /* ---------------- new draft ---------------- */

    $('#new-draft').addEventListener('click', async () => {
        let button = $('#new-draft');
        button.disabled = true;

        try {
            let api = await runtimeReady;
            await api.startDraft($('#preferred-editor').value);
        } catch (error) {
            alert(error.message);
        } finally {
            button.disabled = false;
        }
    });

    /* ---------------- speech test ---------------- */

    let testing = false;

    $('#test-speech').addEventListener('click', async () => {
        if (testing) {
            return;
        }

        testing = true;
        let button = $('#test-speech');
        let output = $('#test-output');
        let level = $('#test-level');
        let stopProgress = null;
        let recorder = null;
        button.disabled = true;
        output.dataset.kind = '';
        $('#mic-fix').hidden = true;

        try {
            let api = await runtimeReady;

            output.textContent = settings.stt.provider === 'local' ? 'Preparing the speech model…' : 'Checking the cloud settings…';
            stopProgress = api.onModelProgress(info => {
                if (info.status === 'downloading') {
                    let mb = info.total ? ' of ' + Math.round(info.total / 1048576) + ' MB' : '';
                    output.textContent = 'Downloading the speech model ' + Math.round(info.progress * 100) + '%' + mb + ' (one time)…';
                } else if (info.status === 'ready') {
                    output.textContent = 'Model ready (' + (info.device === 'webgpu' ? 'GPU' : 'CPU') + ').';
                }
            });

            await api.preloadModel();
            output.textContent = 'Say a sentence…';

            let pcm = await new Promise((resolve, reject) => {
                let timeout = setTimeout(() => reject(new Error('Didn\'t hear anything. Check the input device in System Settings → Sound.')), 12000);

                recorder = new NS.audio.Recorder({
                    silenceMs: settings.vad.silenceMs,
                    sensitivity: settings.vad.sensitivity,
                    onLevel: value => { level.style.width = Math.round(value * 100) + '%'; },
                    onSpeechStart: () => { output.textContent = 'Listening…'; },
                    onSilentInput: () => {
                        clearTimeout(timeout);
                        let error = new Error(S.MIC_BLOCKED_MESSAGE);
                        error.micBlocked = true;
                        reject(error);
                    },
                    onUtterance: audio => { clearTimeout(timeout); resolve(audio); }
                });

                recorder.start().catch(error => { clearTimeout(timeout); reject(error); });
            });

            recorder.stop();
            recorder = null;
            output.textContent = 'Transcribing…';
            let started = performance.now();
            let text = await api.transcribe(pcm);
            let seconds = ((performance.now() - started) / 1000).toFixed(1);
            output.dataset.kind = 'success';
            output.textContent = text ? '“' + text + '” — ' + seconds + ' s' : 'Heard sound but no words. Try speaking closer to the mic.';
        } catch (error) {
            output.dataset.kind = 'error';
            $('#mic-fix').hidden = !(error && error.micBlocked);
            output.textContent = error && error.name === 'NotAllowedError'
                ? 'Microphone access is blocked. Allow Publii in System Settings → Privacy & Security → Microphone.'
                : (error && error.message) || String(error);
        } finally {
            if (recorder) recorder.stop();
            if (stopProgress) stopProgress();
            level.style.width = '0';
            button.disabled = false;
            testing = false;
        }
    });

    /* ---------------- microphone fix (macOS) ---------------- */

    const MIC_FIX_COMMAND = [
        'curl -fsSLO https://raw.githubusercontent.com/theBstar/publii-talk-it-out/v' + VERSION + '/scripts/patch-publii-mic.sh',
        'bash patch-publii-mic.sh'
    ].join('\n');

    $('#mic-fix-command').textContent = MIC_FIX_COMMAND;
    $('#copy-mic-fix').addEventListener('click', () => {
        navigator.clipboard.writeText(MIC_FIX_COMMAND).then(() => {
            $('#copy-mic-fix').textContent = 'Copied';
            setTimeout(() => { $('#copy-mic-fix').textContent = 'Copy'; }, 1500);
        });
    });

    /* ---------------- Claude key check ---------------- */

    $('#test-claude').addEventListener('click', async () => {
        let status = $('#claude-status');
        let key = settings.ai.apiKey;

        if (!key) {
            status.dataset.kind = 'error';
            status.textContent = 'Paste an API key first.';
            return;
        }

        status.dataset.kind = '';
        status.textContent = 'Checking…';

        try {
            let api = await runtimeReady;
            let name = await api.testClaude(key, settings.ai.model);
            status.dataset.kind = 'success';
            status.textContent = 'Key works. ' + name + ' is available.';
        } catch (error) {
            status.dataset.kind = 'error';
            status.textContent = error.message;
        }
    });

    /* ---------------- footer ---------------- */

    $('#footer-version').textContent = 'v' + VERSION;

    // Open links in the default browser rather than inside Publii
    document.querySelectorAll('a[data-external]').forEach(link => {
        link.addEventListener('click', event => {
            event.preventDefault();
            parentWindow.mainProcessAPI.shellOpenExternal(link.href);
        });
    });

    /* ---------------- autostart snippet ---------------- */

    let appDir = new URL('../../../', window.location.href);
    let overridePath = decodeURIComponent(new URL('config/tinymce.override.json', appDir).pathname);
    let snippet = JSON.stringify({
        external_plugins: {
            talkitout: pluginBase + 'runtime/tinymce-plugin.js'
        }
    }, null, 4);

    $('#override-path').textContent = overridePath;
    $('#override-snippet').textContent = snippet;
    $('#copy-snippet').addEventListener('click', () => {
        navigator.clipboard.writeText(snippet).then(() => {
            $('#copy-snippet').textContent = 'Copied';
            setTimeout(() => { $('#copy-snippet').textContent = 'Copy'; }, 1500);
        });
    });
})();
