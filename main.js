/*
 * Talk It Out works inside Publii's editors, not in the generated website,
 * so it adds nothing to rendered pages. Publii still requires a main.js for
 * every enabled plugin; the editor code lives in runtime/ and options/.
 */
class TalkItOutPlugin {
    constructor (API, name, config) {
        this.API = API;
        this.name = name;
        this.config = config;
    }
}

module.exports = TalkItOutPlugin;
