/*
 * Talk It Out — TinyMCE external plugin.
 *
 * Optional auto-start: when ~/Documents/Publii/config/tinymce.override.json
 * lists this file under "external_plugins", TinyMCE loads it every time the
 * WYSIWYG editor opens, and it boots Talk It Out without visiting the
 * plugin's settings page first. The install script can set this up.
 */
(function () {
    'use strict';

    var tinymce = window.tinymce;

    if (!tinymce || !tinymce.PluginManager) {
        return;
    }

    function ensureLoaded () {
        if (window.TalkItOut || window.__talkItOutLoading) {
            return;
        }

        // TinyMCE records the folder each external plugin was loaded from
        var base = (tinymce.PluginManager.urls && tinymce.PluginManager.urls.talkitout) || '';
        var script = document.createElement('script');
        script.src = base.replace(/\/$/, '') + '/loader.js?v=0.1.0';
        document.head.appendChild(script);
    }

    tinymce.PluginManager.add('talkitout', function () {
        ensureLoaded();

        return {
            getMetadata: function () {
                return { name: 'Talk It Out' };
            }
        };
    });
})();
