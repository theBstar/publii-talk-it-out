/*
 * Talk It Out — boot. Creates the session and panel once per Publii window
 * and exposes a small API on window.TalkItOut (used by the settings page).
 */
(function (root) {
    'use strict';

    const NS = root.TalkItOutNS;
    const VERSION = '0.1.0';
    const REPO_URL = 'https://github.com/theBstar/publii-talk-it-out';
    // Publii minor versions this release was built and tested against
    const TESTED_PUBLII = ['0.47'];

    function publiiVersion () {
        try {
            let vm = NS.bridge.vueRoot();
            let info = vm.$store.state.app.versionInfo || {};
            return String(info.version || info.number || '');
        } catch (e) {
            return '';
        }
    }

    NS.boot = function boot ({ baseUrl, pluginDir }) {
        if (root.TalkItOut) {
            return root.TalkItOut;
        }

        const session = new NS.Session();
        const panel = new NS.Panel(session, baseUrl, pluginDir);
        const publii = publiiVersion();
        const tested = !publii || TESTED_PUBLII.some(prefix => publii === prefix || publii.indexOf(prefix + '.') === 0);

        // Talk It Out relies on Publii internals, so say so up front on untested versions
        if (!tested) {
            let warned = false;

            NS.bridge.onRouteChange(() => {
                if (!warned && NS.bridge.editorRoute()) {
                    warned = true;
                    setTimeout(() => panel.notify('Talk It Out hasn\'t been tested with Publii ' + publii + ' yet. If something misbehaves, please report it.', 'warn', [
                        { label: 'Report an issue', run: () => window.mainProcessAPI.shellOpenExternal(REPO_URL + '/issues') }
                    ]), 600);
                }
            });
        }

        // ⌥⇧V listen · ⌥⇧C dictate/edit · ⌥⇧D draft. event.code, because Option changes event.key on macOS
        const keyHandler = event => {
            if (!event.altKey || !event.shiftKey || event.metaKey || event.ctrlKey) {
                return;
            }

            let action = {
                KeyV: () => session.toggle(),
                KeyC: () => session.setMode(session.mode === 'command' ? 'dictate' : 'command'),
                KeyD: () => session.setMode(session.mode === 'draft' ? 'dictate' : 'draft')
            }[event.code];

            if (action && NS.bridge.editorRoute()) {
                event.preventDefault();
                event.stopPropagation();
                action();
            }
        };

        document.addEventListener('keydown', keyHandler, true);
        session.setKeyHandler(keyHandler);

        NS.bridge.onRouteChange(() => session.onRoute());
        session.onRoute();

        // Settings are edited in the plugin's settings page (another document, same storage)
        root.addEventListener('storage', event => {
            if (event.key === NS.settings.STORAGE_KEY) {
                session.settingsChanged();
            }
        });

        root.TalkItOut = Object.freeze({
            version: VERSION,
            repoUrl: REPO_URL,
            compatibility: () => ({ publii, tested, testedWith: TESTED_PUBLII.slice() }),
            start: () => session.start(),
            stop: () => session.stop(),
            setMode: mode => session.setMode(mode),

            async startDraft (editor) {
                let kind = editor || NS.settings.load().ui.preferredEditor;

                if (!NS.bridge.openNewItem(kind)) {
                    throw new Error('Open a site in Publii first.');
                }

                let adapter = await session.waitForAdapter();

                if (!adapter) {
                    throw new Error('The editor did not open.');
                }

                session.setMode('draft');
                await session.start();
            },

            preloadModel: () => session.prepareEngine(),
            onModelProgress: listener => session.onModelProgress(listener),
            transcribe: async pcm => (await session.prepareEngine()).transcribe(pcm, {}),
            settingsChanged: () => session.settingsChanged(),
            testClaude: (apiKey, model) => NS.claude.testConnection(apiKey, model),
            usage: () => NS.claude.usage(),

            // Runs 16 kHz PCM through the same pipeline as the microphone (testing/debugging)
            simulateUtterance (pcm, duration) {
                session._enqueue(pcm, duration || pcm.length / NS.audio.TARGET_RATE);
                return session.queue;
            },

            // Same, starting from an already-transcribed utterance
            simulateText (text) {
                session.queue = session.queue.then(() => session.handleTranscript(text));
                return session.queue;
            },

            status: () => ({
                listening: session.listening,
                mode: session.mode,
                engineReady: session.engineReady,
                hasDraft: !!(session.draft && session.draft.segments.length)
            })
        });

        return root.TalkItOut;
    };
})(window);
