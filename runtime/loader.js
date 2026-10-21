/*
 * Talk It Out — loader. Injected into Publii's main window, either by the
 * plugin's settings page or by the TinyMCE external plugin. Loads the runtime
 * scripts in order, once per window.
 */
(function () {
    'use strict';

    if (window.TalkItOut || window.__talkItOutLoading) {
        return;
    }

    window.__talkItOutLoading = true;

    const FILES = [
        'commands.js',
        'settings.js',
        'bridge.js',
        'adapters/common.js',
        'adapters/tinymce.js',
        'adapters/blockeditor.js',
        'adapters/markdown.js',
        'audio.js',
        'stt.js',
        'claude.js',
        'engine.js',
        'ui.js',
        'index.js'
    ];

    const self = document.currentScript || document.querySelector('script[src*="talk-it-out"][src$="loader.js"], script[src*="/runtime/loader.js"]');
    const src = self.src;
    const baseUrl = src.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
    const version = (src.match(/[?&]v=([^&#]+)/) || [])[1] || String(Date.now());
    const pluginDir = decodeURIComponent(baseUrl.replace(/\/runtime\/$/, '').split('/').pop());

    function load (file) {
        return new Promise((resolve, reject) => {
            let script = document.createElement('script');
            script.src = baseUrl + file + '?v=' + encodeURIComponent(version);
            script.async = false;
            script.onload = resolve;
            script.onerror = () => reject(new Error('Talk It Out: could not load ' + file));
            document.head.appendChild(script);
        });
    }

    FILES.reduce((chain, file) => chain.then(() => load(file)), Promise.resolve())
        .then(() => {
            window.TalkItOutNS.boot({ baseUrl, pluginDir });
            window.dispatchEvent(new CustomEvent('talk-it-out-ready'));
        })
        .catch(error => {
            console.error(error);
            window.__talkItOutLoading = false;
        });
})();
