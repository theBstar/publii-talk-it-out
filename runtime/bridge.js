/*
 * Talk It Out — bridge to the Publii app.
 *
 * Publii does not expose editor hooks to plugins, so this reaches the running
 * Vue app through the DOM (Vue 2 stores the instance on `element.__vue__`).
 * Everything here is defensive: if a Publii update changes the internals, the
 * functions return null instead of throwing.
 */
(function (root) {
    'use strict';

    const EDITOR_ROUTE = /^\/site\/([^/]+)\/(posts|pages)\/editor\/(tinymce|blockeditor|markdown)(?:\/([^/?#]*))?/;

    function vueRoot () {
        let candidates = [
            document.getElementById('app'),
            document.querySelector('.app-view'),
            document.querySelector('.post-editor')
        ];

        for (const el of candidates) {
            if (el && el.__vue__) {
                return el.__vue__.$root;
            }
        }

        for (const el of document.body.children) {
            if (el.__vue__) {
                return el.__vue__.$root;
            }
        }

        return null;
    }

    function router () {
        let vm = vueRoot();
        return vm ? vm.$router : null;
    }

    function currentPath () {
        let r = router();

        if (r && r.currentRoute) {
            return r.currentRoute.path;
        }

        // Publii uses hash routing on file://
        return (window.location.hash || '').replace(/^#/, '');
    }

    function editorRoute () {
        let match = currentPath().match(EDITOR_ROUTE);

        if (!match) {
            return null;
        }

        return {
            site: decodeURIComponent(match[1]),
            itemType: match[2] === 'pages' ? 'page' : 'post',
            editor: match[3],
            id: match[4] || ''
        };
    }

    function siteName () {
        try {
            if (window.app && typeof window.app.getSiteName === 'function') {
                return window.app.getSiteName();
            }
        } catch (e) {}

        let match = currentPath().match(/^\/site\/([^/]+)/);
        return match ? decodeURIComponent(match[1]) : null;
    }

    function onRouteChange (callback) {
        let r = router();

        if (r && typeof r.afterEach === 'function') {
            r.afterEach(to => setTimeout(() => callback(to.path), 0));
        }

        window.addEventListener('hashchange', () => callback(currentPath()));
    }

    function openNewItem (editor, itemType = 'post') {
        let site = siteName();
        let r = router();

        if (!site || !r) {
            return false;
        }

        let section = itemType === 'page' ? 'pages' : 'posts';
        r.push('/site/' + encodeURIComponent(site) + '/' + section + '/editor/' + editor + '/');
        return true;
    }

    // The component behind the current editor route (PostEditorTinyMCE etc.)
    function editorComponent () {
        let el = document.querySelector('.post-editor');
        return el && el.__vue__ && typeof el.__vue__.savePost === 'function' ? el.__vue__ : null;
    }

    // Like Publii's own "Save" button it keeps the current status, except that a
    // never-saved item (empty status) is saved as a draft: voice never publishes.
    function savePost () {
        let vm = editorComponent();

        if (!vm || !vm.postData) {
            return false;
        }

        let currentStatus = String(vm.postData.status || '');
        let status = currentStatus === '' || currentStatus.indexOf('draft') > -1 ? 'draft' : 'published';

        vm.savePost(status, false, false);
        return true;
    }

    function reportChange () {
        try {
            if (window.app && typeof window.app.reportPossibleDataLoss === 'function') {
                window.app.reportPossibleDataLoss();
            }
        } catch (e) {}
    }

    function titleElement () {
        return document.querySelector('.post-editor #post-title');
    }

    function getTitle () {
        let el = titleElement();
        return el ? el.innerText.replace(/\n/g, ' ').trim() : '';
    }

    function setTitle (text) {
        let el = titleElement();

        if (!el) {
            return false;
        }

        el.innerText = text;
        // Publii syncs the title (and slug) on the element's input event
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    }

    root.TalkItOutNS = root.TalkItOutNS || {};
    root.TalkItOutNS.bridge = {
        vueRoot,
        router,
        currentPath,
        editorRoute,
        siteName,
        onRouteChange,
        openNewItem,
        editorComponent,
        savePost,
        reportChange,
        getTitle,
        setTitle
    };
})(window);
