
const electron = require('electron');

const kbpgp = require('kbpgp');
const axios = require('axios');

const KEYBASE_PROOFS_GUILD = '440982847675826187';
const KEYBASE_PROOFS_CHANNEL = '440983046418726912';
const KEYBASE_PROOFS_GUILD_INVITE = 'AJau2qQ';

const componentProofs = new WeakMap();

const promisify = (f, ...bind) => (...args) => new Promise((resolve, reject) => {
    if (!bind.length) bind.push(f);
    f.call(...bind, ...args, (err, r) => {
        if (err) reject(err);
        else resolve(r);
    });
});

const kbpgpVerify = promisify(kbpgp.unbox, kbpgp);
const kbpgpImportFromArmoredPgp = promisify(kbpgp.KeyManager.import_from_armored_pgp, kbpgp.KeyManager);

module.exports = (Plugin, PluginApi, Vendor) => {
    const { Utils, Logger, DiscordApi, ReactComponents, ReactHelpers, Patcher, monkeyPatch, Reflection, CommonComponents, Modals, CssUtils, Api } = PluginApi;
    const { React, ReactDOM } = ReactHelpers;
    const { Modal, Button, ContentAuthor } = CommonComponents;

    const WebpackModules = new Proxy(PluginApi.WebpackModules, {
        get(WebpackModules, property) {
            return WebpackModules[property] || WebpackModules.getModuleByName(property);
        }
    });

    return class KeybaseIntegration extends Plugin {
        get api() { return PluginApi }
        get kbpgp() { return kbpgp }

        get promisify() { return promisify }
        get kbpgpVerify() { return kbpgpVerify }
        get wm() { return WebpackModules }

        get componentProofs() { return componentProofs }

        async onstart() {
            Logger.log('Keybase integration started');
            this.patchUserProfileModal();
            this.patchContentAuthor();

            await CssUtils.injectSass(`.kbi-modal-body * {
                margin: 0 0 15px;
            }

            .kbi-button {
                padding: 8px 15px;
                border-radius: 3px;
            }

            .kbi-icon {
                width: 30px;
                height: 30px;
                margin-right: 10px;
            }

            .kbi-error {
                margin: 0 20px;
                padding: 8px 14px 8px 8px;
                color: #ffffff;
                background-color: transparentize(#d84040, 0.5);
                border: 1px solid #d84040;
                border-radius: 3px;
                display: flex;
                align-items: center;

                + .kbi-error {
                    margin-top: 20px;
                }

                .kbi-error-text {
                    flex: 1 1;
                }

                .kbi-account-open-icon {
                    cursor: pointer;
                    filter: contrast(5);
                }
            }

            [data-channel-id="${KEYBASE_PROOFS_CHANNEL}"] svg[name="People"],
            [data-channel-id="${KEYBASE_PROOFS_CHANNEL}"] [class*="membersWrap-"],
            [data-channel-id="441653700260528130"] svg[name="People"],
            [data-channel-id="441653700260528130"] [class*="membersWrap-"] {
                display: none;
            }`);

            // Check if the user is in the proofs server, if not ask them to join
            const proofsGuild = DiscordApi.Guild.fromId(KEYBASE_PROOFS_GUILD);
            if (!proofsGuild) this.askUserToJoinGuild();
        }

        onstop() {
            Logger.log('Keybase integration stopped');
            Patcher.unpatchAll();
        }

        get bridge() {
            return this._bridge || (this._bridge = {
                version: this.version,
                getUserPublicKeys: this.getUserPublicKeys.bind(this),
                getUserProofMessages: this.getUserProofMessages.bind(this),
                getUserProofs: this.getUserProofs.bind(this),
                getValidUserProofs: this.getValidUserProofs.bind(this)
            });
        }

        askUserToJoinGuild() {
            const modal = Modals.add({
                Modal, Button,
                joinGuild: () => modal.close() && WebpackModules.InviteActions.acceptInviteAndTransitionToInviteChannel(KEYBASE_PROOFS_GUILD_INVITE)
            }, joinGuildModal);
        }

        /**
         * Gets the public keys of the user from Keybase.
         * @param {String} keybase The user's Keybase username
         * @return {Promise => Array}
         */
        async getUserPublicKeys(keybase) {
            Logger.log(`Getting user ${keybase}'s proofs`);
            const response = await axios.get(`https://keybase.io/${keybase}/pgp_keys.asc`);
            Logger.log('Response:', response);
            return [response.data];
        }

        /**
         * Searches the proofs channel for messages from a user and returns the contents of the last two code blocks (the signed proof).
         * @param {Number} user_id The ID of the user
         * @return {Promise => Array}
         */
        async getUserProofMessages(user_id) {
            const response = await WebpackModules.APIModule.get(`/guilds/${KEYBASE_PROOFS_GUILD}/messages/search?channel_id=${KEYBASE_PROOFS_CHANNEL}&author_id=${user_id}`);
            const searchResults = response.body;

            const proofs = [];

            for (let messages of searchResults.messages) {
                const message = messages.find(m => m.hit);
                const messageRegex = /```\s*([^`]+)\s*```/g;

                const matches = [];
                let _match;
                while ((_match = messageRegex.exec(message.content)) !== null) matches.push(_match);

                const signatureMatch = matches.pop();
                const objectMatch = matches.pop();

                if (signatureMatch && signatureMatch[1] && objectMatch && objectMatch[1]) proofs.push({
                    object: JSON.parse(objectMatch[1]),
                    guild_id: KEYBASE_PROOFS_GUILD,
                    channel_id: KEYBASE_PROOFS_CHANNEL,
                    message_id: message.id,
                    signature: signatureMatch[1]
                });
            }

            return proofs;
        }

        /**
         * Gets all a user's proofs.
         * @param {Number} user_id The ID of the user
         * @return {Promise => Array}
         */
        async getUserProofs(user_id) {
            const proofs = [];
            const keybaseUsers = new Map();

            for (let message of await this.getUserProofMessages(user_id)) {
                const proof = {
                    guild_id: message.guild_id,
                    channel_id: message.channel_id,
                    message_id: message.message_id,
                    message,
                    valid: false,
                    duplicate: false,
                    error: undefined
                };

                try {
                    const pgp_msg = proof.pgp_msg = `-----BEGIN PGP MESSAGE-----\n\n${message.signature}\n-----END PGP MESSAGE-----`;

                    if (!keybaseUsers.has(message.object.keybase)) {
                        const fingerprints = [];
                        const ring = new kbpgp.keyring.KeyRing();
                        keybaseUsers.set(message.object.keybase, {fingerprints, ring});

                        for (let armored of await this.getUserPublicKeys(message.object.keybase)) {
                            const keyManager = await kbpgpImportFromArmoredPgp({armored});

                            ring.add_key_manager(keyManager);
                            fingerprints.push(keyManager.get_pgp_fingerprint_str());
                        }
                    }

                    const {fingerprints, ring} = keybaseUsers.get(message.object.keybase);
                    proof.keybase_fingerprints = fingerprints;

                    const literals = await kbpgpVerify({keyfetch: ring, armored: pgp_msg});
                    Logger.log('Signed message', literals[0].toString());
                    const signer = literals[0].get_data_signer();
                    const signerKeyManager = signer.get_key_manager();
                    const fingerprint = proof.fingerprint = signerKeyManager.get_pgp_fingerprint_str();

                    Logger.log('Fingerprints:', {fingerprints, fingerprint});
                    if (!fingerprints.includes(fingerprint)) {
                        throw new Error('Signature is not valid.');
                    }

                    Logger.log('Fingerprint matches!');
                    Object.assign(proof, JSON.parse(literals[0].toString()), Object.assign({}, proof));

                    if (proof.keybase_proof !== 'discord')
                        throw new Error('`proof.keybase_proof` was not set to `discord`.');
                    if (proof.discord !== user_id)
                        throw new Error('`proof.discord` does not match the user ID.');
                    if (message.object.discord_id && proof.discord !== message.object.discord_id)
                        throw new Error('`proof.discord` does not match the user ID.');
                    if (proof.keybase !== message.object.keybase)
                        throw new Error('`proof.keybase` does not match the Keybase username.');

                    proof.valid = true;
                } catch (err) {
                    Logger.err(err);
                    proof.error = err;
                }

                for (let p of proofs) {
                    if (p.keybase !== proof.keybase || p.discord_id !== proof.discord_id) continue;
                    else if (p.valid) proof.duplicate = true;
                    else if (proof.valid) p.duplicate = true;
                }

                proofs.push(proof);
            }

            return proofs;
        }

        /**
         * Gets all a user's valid proofs.
         * @param {Number} user_id The ID of the user
         * @return {Promise => Array}
         */
        async getValidUserProofs(user_id) {
            return (await this.getUserProofs(user_id)).filter(p => p.valid && !p.duplicate);
        }

        /**
         * Patches UserProfileModal to render profile badges.
         */
        async patchUserProfileModal() {
            const UserProfileModal = this.UserProfileModal = await ReactComponents.getComponent('UserProfileModal');

            this.unpatchUserProfileModal = monkeyPatch(UserProfileModal.component.prototype).after('render', (component, args, retVal, setRetVal) => {
                Logger.log('Rendering UserProfileModal', component, args, retVal);

                if (ReactHelpers.findProp(component, 'section') !== 'USER_INFO') return;

                const FluxContainer = retVal.props.children[1].props.children.type;
                retVal.props.children[1].props.children.type = this.patchedFluxContainer(FluxContainer);
            });

            // Rerender all user profile modals
            const selector = '.' + WebpackModules.getModuleByProperties('root', 'topSectionNormal').root;
            for (let element of document.querySelectorAll(selector)) {
                Reflection(element).forceUpdate();
            }
        }

        async getUserProofsAndUpdateComponent(component) {
            await Utils.wait(500);
            const user = ReactHelpers.findProp(component, 'user');
            if (!user) return;
            componentProofs.set(component, await this.getUserProofs(user.id));
            component.setState({});
        }

        patchedFluxContainer(FluxContainer) {
            if (this._patchedFluxContainer) return this._patchedFluxContainer;

            return this._patchedFluxContainer = class PatchedFluxContainer extends FluxContainer {
                render() {
                    const retVal = FluxContainer.prototype.render.call(this, arguments);
                    try {
                        Logger.log('Rendering PatchedFluxContainer', this, arguments, retVal);
                        retVal.type = Api.plugin.patchedUserInfoSection(retVal.type);
                    } catch (err) {
                        Logger.err('Error thrown while rendering a FluxContainer', err);
                    }
                    return retVal;
                }
            };
        }

        patchedUserInfoSection(UserInfoSection) {
            if (this._patchedUserInfoSection) return this._patchedUserInfoSection;

            return this._patchedUserInfoSection = class PatchedUserInfoSection extends UserInfoSection {
                render() {
                    const retVal = UserInfoSection.prototype.render.call(this, arguments);
                    try {
                        Logger.log('Rendering PatchedUserInfoSection', this, arguments, retVal);

                        const user = ReactHelpers.findProp(this, 'user');

                        if (!componentProofs.has(this)) return Api.plugin.getUserProofsAndUpdateComponent(this), retVal;
                        const proofs = componentProofs.get(this);
                        if (!proofs || !proofs.length) return retVal;

                        Logger.log('Got proofs', proofs);

                        const connectedAccounts = retVal.props.children[1].props.children;
                        for (let proof of proofs) {
                            if (proof.duplicate) continue;
                            else if (!proof.valid)
                                retVal.props.children.splice(1, 0, Api.plugin.renderInvalidKeybaseAccount(proof));
                            else connectedAccounts.props.children.splice(proof.position || 0, 0, Api.plugin.renderKeybaseAccount(proof));
                        }
                    } catch (err) {
                        Logger.err('Error thrown while rendering a UserInfoSection', err);
                    }
                    return retVal;
                }
            };
        }

        renderKeybaseAccount(proof) {
            return React.createElement('div', {
                className: 'flex-1xMQg5 flex-1O1GKY horizontal-1ae9ci horizontal-2EEEnY flex-1O1GKY directionRow-3v3tfG justifyStart-2NDFzi alignCenter-1dQNNs noWrap-3jynv6 connectedAccount-36nQx7'
            }, React.createElement('img', {
                className: 'connectedAccountIcon-3P3V6F',
                src: 'https://keybase.io/images/icons/icon-keybase-logo-48.png'
            }), React.createElement('div', {
                className: 'connectedAccountNameInner-1phBvE flex-1O1GKY alignCenter-1dQNNs' + ' connectedAccountName-f8AEe2',
            }, proof.keybase, proof.valid ? this.renderVerifiedIcon(proof) : null), React.createElement('a', {
                href: `https://keybase.io/${proof.keybase}`,
                target: '_blank'
            }, React.createElement('div', {
                className: 'connectedAccountOpenIcon-2cNbq5'
            })));
        }

        renderInvalidKeybaseAccount(proof) {
            return React.createElement('div', {
                className: 'kbi-error'
            }, React.createElement('img', {
                className: 'kbi-icon',
                src: 'https://keybase.io/images/icons/icon-keybase-logo-48.png'
            }), React.createElement('span', {
                className: 'kbi-error-text'
            }, `Invalid proof: ${proof.error}`), React.createElement('div', {
                className: 'kbi-account-open-icon connectedAccountOpenIcon-2cNbq5',
                onClick(event) {
                    const {guild_id, channel_id, message_id} = proof.message;
                    if (guild_id && channel_id && message_id) {
                        WebpackModules.UserProfileModal.close();
                        WebpackModules.NavigationUtils.transitionTo(`/channels/${guild_id}/${channel_id}?jump=${message_id}`);
                    }
                }
            }));
        }

        renderVerifiedIcon(proof) {
            const Tooltips = WebpackModules.getModule(m => m.hide && m.show && !m.search && !m.submit && !m.search && !m.activateRagingDemon && !m.dismiss);
		    const id = WebpackModules.KeyGenerator();
            let svgElement;

            return React.createElement('svg', {
                className: "connectedAccountVerifiedIcon-3aZz_K",
                name: "Verified",
                width: "24",
                height: "20",
                viewBox: "0 0 20 20",
                onClick(event) {
                    Logger.log('Clicked verified icon', proof);
                    const {guild_id, channel_id, message_id} = proof.message;
                    if (guild_id && channel_id && message_id) {
                        WebpackModules.UserProfileModal.close();
                        WebpackModules.NavigationUtils.transitionTo(`/channels/${guild_id}/${channel_id}?jump=${message_id}`);
                    }
                },
                onMouseOver(event) {
                    if (event.target.tagName !== 'svg') return;
                    svgElement = event.target;
                    const position = event.target.getBoundingClientRect();

                    Tooltips.show(id, {
                        position: 'top',
                        text: 'Verified',
                        color: 'black',
                        targetWidth: event.target.clientWidth,
                        targetHeight: event.target.clientHeight,
                        x: position.left,
                        y: position.top
                    });
                },
                onMouseOut(event) {
                    if (event.target !== svgElement) return;
                    Tooltips.hide(id);
                }
            }, React.createElement('g', {
                fill: "none",
                'fill-rule': "evenodd"
            }, React.createElement('path', {
                fill: "transparent",
                d: `M10,19.9894372 C10.1068171,19.9973388 10.2078869,20.000809 10.3011305,19.9998419 C11.2600164,19.8604167 12.3546966,19.5885332 12.8510541,19.0579196 C13.25685,18.6241176 13.617476,18.0901301 13.7559228,17.5412583 C14.9847338,18.4452692 17.0357846,18.1120142 18.1240732,16.9486174 C19.1632035,15.8377715 18.521192,14.1691402 18.1240732,13.1586037 C18.4557396,12.9959068 18.8016154,12.6966801 19.0750308,12.4043949 C19.7126372,11.7227841 20.0201294,10.9139249 19.9989792,10.0282152 C20.0201294,9.14250542 19.7126372,8.3336462 19.0750308,7.65203538 C18.8016154,7.35975019 18.4557396,7.06052352 18.1240732,6.89782664 C18.521192,5.88729007 19.1632035,4.21865882 18.1240732,3.10781287 C17.0357846,1.94441607 14.9847338,1.61116112 13.7559228,2.51517206 C13.617476,1.96630024 13.25685,1.4323127 12.8510541,0.998510722 C12.3546966,0.467897141 11.2584098,0.139640848 10.2995239,0.036840309 C10.2065991,-0.000647660524 10.1059015,0.00279555358 9.99948865,0.0106399384 C9.87772075,0.00268415336 9.76807998,-0.00081194858 9.67455589,0.000158000197 C8.88885259,0.157529668 7.63153446,0.482616331 7.14894593,0.998510722 C6.74314998,1.4323127 6.382524,1.96630024 6.24407717,2.51517206 C5.01526618,1.61116112 2.96421535,1.94441607 1.87592682,3.10781287 C0.836796482,4.21865882 1.47880798,5.88729007 1.87592682,6.89782664 C1.54426039,7.06052352 1.19838464,7.35975019 0.924969216,7.65203538 C0.287362828,8.3336462 -0.0201294289,9.14250542 0.00102081603,10.0282151 C-0.0201294289,10.9139249 0.287362828,11.7227841 0.924969216,12.4043949 C1.19838464,12.6966801 1.54426039,12.9959068 1.87592682,13.1586037 C1.47880798,14.1691402 0.836796482,15.8377715 1.87592682,16.9486174 C2.96421535,18.1120142 5.01526618,18.4452692 6.24407717,17.5412583 C6.382524,18.0901301 6.74314998,18.6241176 7.14894593,19.0579196 C7.63153446,19.573814 8.89045919,19.8426283 9.6761625,19.9541287 C9.7694061,20.000809 9.87866986,19.9973388 10,19.9894372 Z`
            }), React.createElement('path', {
                fill: "#4f545c",
                d: `M10.0004091,17.9551224 C10.0858672,17.9614327 10.1667272,17.964204 10.2413259,17.9634317 C11.0084737,17.8520863 11.8842627,17.6349594 12.281369,17.2112099 C12.6060224,16.8647745 12.8945379,16.4383305 13.005301,16 C13.9884001,16.7219456 15.6293247,16.4558073 16.5,15.5267154 C17.3313468,14.6395908 16.8177113,13.3070173 16.5,12.5 C16.7653467,12.3700698 17.0420615,12.1311066 17.260805,11.8976868 C17.7709162,11.3533505 18.0169226,10.7073933 18.0000015,10.0000632 C18.0169226,9.29273289 17.7709162,8.64677569 17.260805,8.10243942 C17.0420615,7.86901966 16.7653467,7.63005642 16.5,7.50012624 C16.8177113,6.69310896 17.3313468,5.36053545 16.5,4.47341082 C15.6293247,3.54431894 13.9884001,3.27818062 13.005301,4.00012624 C12.8945379,3.5617957 12.6060224,3.13535178 12.281369,2.78891632 C11.8842627,2.36516686 11.0071884,2.10302048 10.2400405,2.02092369 C10.1656968,1.99098569 10.0851346,1.99373545 10,2 C9.9025807,1.99364649 9.8148636,1.99085449 9.7400405,1.9916291 C9.11144571,2.11730654 8.10553978,2.37692165 7.71944921,2.78891632 C7.39479585,3.13535178 7.10628031,3.5617957 6.99551718,4.00012624 C6.01241812,3.27818062 4.37149355,3.54431894 3.5008182,4.47341082 C2.66947142,5.36053545 3.18310688,6.69310896 3.5008182,7.50012624 C3.23547149,7.63005642 2.95875674,7.86901966 2.74001321,8.10243942 C2.22990202,8.64677569 1.98389563,9.29273289 2.00081669,10.0000631 C1.98389563,10.7073933 2.22990202,11.3533505 2.74001321,11.8976868 C2.95875674,12.1311066 3.23547149,12.3700698 3.5008182,12.5 C3.18310688,13.3070173 2.66947142,14.6395908 3.5008182,15.5267154 C4.37149355,16.4558073 6.01241812,16.7219456 6.99551718,16 C7.10628031,16.4383305 7.39479585,16.8647745 7.71944921,17.2112099 C8.10553978,17.6232046 9.11273107,17.8378805 9.74132585,17.926925 C9.81592455,17.964204 9.90334002,17.9614327 10.0004091,17.9551224 Z`
            }), React.createElement('path', {
                fill: "#ffffff",
                d: "M8.84273967,12.8167603 L13.8643,7.7952 C14.0513,7.6072 14.0513,7.3042 13.8643,7.1172 C13.6773,6.9312 13.3743,6.9312 13.1863,7.1172 L8.52303089,11.78139 L6.8883,10.1475 C6.6843,9.9445 6.3553,9.9445 6.1523,10.1475 C5.9493,10.3515 5.9493,10.6805 6.1523,10.8835 L8.08381122,12.8160053 C8.09561409,12.8309877 8.10844368,12.8454178 8.1223,12.8592 C8.3093,13.0472 8.6123,13.0472 8.8003,12.8592 L8.82157566,12.8379243 C8.82518839,12.8345112 8.82876362,12.8310364 8.8323,12.8275 C8.83584168,12.8239583 8.83932157,12.820378 8.84273967,12.8167603 Z"
            })));
        }

        patchContentAuthor() {
            Logger.log('ContentAuthor', ContentAuthor);

            // Created event
            ContentAuthor.created = ContentAuthor.created || [];
            if (ContentAuthor._Ctor) ContentAuthor._Ctor[0].options.created = ContentAuthor.created;
            if (!ContentAuthor.created.length) ContentAuthor.created.push(() => {});

            this.unpatchContentAuthorCreated = monkeyPatch(ContentAuthor.created).after(0, async (component, args, retVal, setRetVal) => {
                if (!component.author || !component.author.keybase_username) return;
                const {keybase_username, discord_id} = component.author;

                if (discord_id) {
                    // Check the Discord account has proven they and the Keybase account are the same person
                    Logger.log('Checking proofs for Keybase username', keybase_username, 'and Discord', discord_id);

                    const proofs = await this.getValidUserProofs(discord_id);

                    component.keybase_integration_tooltip = `${keybase_username} (Keybase + Discord${!proofs.find(p => p.keybase === keybase_username) ? ' <b>not</b>' : ''} verified - shift + click for more information)`;
                } else {
                    // Show the Keybase username anyway
                    component.keybase_integration_tooltip = `${keybase_username} (shift + click for more information)`;
                }

                component.keybase_integration_username = keybase_username;
            });

            // Data function
            ContentAuthor.data = ContentAuthor.data || (() => ({}));
            if (ContentAuthor._Ctor) ContentAuthor._Ctor[0].options.data = ContentAuthor.data;

            this.unpatchContentAuthorData = monkeyPatch(ContentAuthor._Ctor ? ContentAuthor._Ctor[0].options : ContentAuthor).after('data', (component, args, retVal) => {
                if (!retVal) return;
                retVal.keybase_integration_username = undefined;
                retVal.keybase_integration_discord_verified = false;
                retVal.keybase_integration_tooltip = undefined;
            });

            // hasLinks property
            ContentAuthor.computed = ContentAuthor.computed || {};
            if (ContentAuthor._Ctor) ContentAuthor._Ctor[0].options.computed = ContentAuthor.computed;

            this.unpatchContentAuthorHasLinks = monkeyPatch(ContentAuthor.computed).after('hasLinks', (component, args, retVal, setRetVal) => {
                setRetVal(retVal || !!component.author.keybase_username);
            });

            // Render function
            this.unpatchContentAuthor = monkeyPatch(ContentAuthor._Ctor ? ContentAuthor._Ctor[0].options : ContentAuthor).after('render', (component, [createElement], retVal, setRetVal) => {
                if (!component.keybase_integration_username) return;
                retVal.componentOptions.children[3].children.push(this.renderContentAuthorKeybase(component, createElement));
            });
        }

        renderContentAuthorKeybase(component, createElement) {
            return createElement('div', {
                staticClass: 'bd-material-button',
                directives: [
                    {
                        name: "tooltip",
                        rawName: "v-tooltip",
                        value: component.keybase_integration_tooltip,
                        expression: "keybase_integration_tooltip"
                    }
                ],
                on: {
                    click(event) {
                        if (event.shiftKey) {
                            const modal = Modals.add({
                                Modal
                            }, aboutContentAuthorKeybaseAccountsModal);
                            return;
                        }

                        electron.shell.openExternal(`https://keybase.io/${component.keybase_integration_username}`);
                    }
                }
            }, [this.renderMiKeybase(createElement)]);
        }

        renderMiKeybase(createElement) {
            return createElement('span', {
                staticClass: 'bd-material-design-icon',
                domProps: {
                    innerHTML: `<svg width="16" height="16" viewBox="0 0 24 24"><path d="M10.446 21.371c0 .528-.428.953-.954.953-.525 0-.954-.425-.954-.953 0-.526.428-.954.953-.954.524 0 .951.431.951.955m5.922-.001c0 .528-.428.953-.955.953-.526 0-.952-.425-.952-.953 0-.526.423-.954.949-.954s.954.431.954.955"/><path d="M20.904 12.213l-.156-.204c-.046-.06-.096-.116-.143-.175-.045-.061-.094-.113-.141-.169-.104-.12-.209-.239-.319-.359l-.076-.08-.091-.099-.135-.131c-.015-.018-.032-.034-.05-.053-1.16-1.139-2.505-1.986-3.955-2.504l-.23-.078c.012-.027.024-.055.035-.083.41-1.064.367-2.223-.12-3.255-.491-1.035-1.356-1.8-2.438-2.16-.656-.216-1.23-.319-1.711-.305-.033-.105-.1-.577.496-1.848L10.663 0l-.287.399c-.33.455-.648.895-.945 1.328-.328-.345-.766-.552-1.245-.58L6.79 1.061h-.012c-.033-.003-.07-.003-.104-.003-.99 0-1.81.771-1.87 1.755l-.088 1.402v.003c-.061 1.029.727 1.915 1.755 1.979l1.002.061c-.065.84.073 1.62.405 2.306-1.346.562-2.586 1.401-3.66 2.484C.913 14.391.913 18.051.913 20.994v1.775l1.305-1.387c.266.93.652 1.807 1.145 2.615H5.06c-.833-1.114-1.419-2.426-1.68-3.848l1.913-2.03-.985 3.091 1.74-1.268c3.075-2.234 6.744-2.75 10.91-1.529 1.805.532 3.56.039 4.473-1.257l.104-.165c.091.498.141.998.141 1.496 0 1.563-.255 3.687-1.38 5.512h1.611c.776-1.563 1.181-3.432 1.181-5.512-.001-2.199-.786-4.421-2.184-6.274zM8.894 6.191c.123-1.002.578-1.949 1.23-2.97.025.05.054.097.084.144.264.398.713.625 1.199.605.217-.008.605.025 1.233.232.714.236 1.286.744 1.608 1.425s.349 1.442.079 2.149c-.173.445-.454.82-.806 1.109l-.408-.502-.002-.003c-.279-.341-.694-.535-1.134-.535-.335 0-.664.117-.925.33-.334.27-.514.66-.534 1.058-1.2-.541-1.8-1.643-1.628-3.041l.004-.001zm4.304 5.11l-.519.425c-.046.036-.095.053-.146.053-.066 0-.133-.03-.177-.085l-.111-.135c-.083-.1-.067-.25.034-.334l.51-.42-1.055-1.299c-.109-.133-.091-.33.044-.436.058-.048.126-.072.194-.072.091 0 .181.038.24.113l2.963 3.645c.109.135.09.33-.042.436-.039.029-.082.053-.126.063-.023.006-.045.009-.07.009-.09 0-.178-.04-.24-.113l-.295-.365-1.045.854c-.046.037-.1.055-.154.055-.068 0-.139-.03-.186-.09l-.477-.579c-.082-.102-.068-.252.035-.336l1.051-.857-.426-.533-.002.001zM7.753 4.866l-1.196-.075c-.255-.015-.45-.235-.435-.488l.09-1.401c.014-.245.216-.436.461-.436h.024l1.401.091c.123.006.236.06.317.152.083.094.123.21.116.336l-.007.101c-.32.567-.585 1.134-.773 1.72h.002zm12.524 11.481c-.565.805-1.687 1.081-2.924.718-3.886-1.141-7.396-.903-10.468.701l1.636-5.123-5.291 5.609c.099-3.762 2.453-6.966 5.758-8.311.471.373 1.034.66 1.673.841.16.044.322.074.48.102-.183.458-.119.997.21 1.407l.075.09c-.172.45-.105.975.221 1.374l.475.582c.266.325.659.513 1.079.513.321 0 .635-.111.886-.314l.285-.232c.174.074.367.113.566.113.113 0 .222-.01.33-.035.218-.05.424-.15.598-.291.623-.51.72-1.435.209-2.06l-1.67-2.056c.145-.117.281-.244.408-.381.135.037.271.078.4.12.266.097.533.198.795.315 1.005.445 1.954 1.1 2.771 1.897.029.03.059.055.085.083l.17.175c.038.039.076.079.111.12.079.085.16.175.239.267l.126.15c.045.053.086.104.13.16l.114.15c.04.051.079.102.117.154.838 1.149.987 2.329.404 3.157v.005z"/><path d="M7.719 4.115l-.835-.051.053-.835.834.051-.052.835z"/></svg>`
                }
            });
        }
    };
};

const joinGuildModal = {
    props: ['modal'],
    template: `<component :is="modal.Modal" class="kbi-modal kbi-join-guild-modal" :class="{'bd-modal-out': modal.closing}" headerText="Keybase Proofs Server" @close="modal.close">
        <div slot="body" class="kbi-modal-body">
            <p>You must join the Keybase Proofs server to use the Keybase integration.</p>
            <h3><b>Why?</b></h3>
            <p>Proofs are posted to the #proofs channel in the Keybase Proofs server. If you're not a member of the server you can't post proofs in the #proofs channel and you can't verify other people's proofs.</p>
            <component :is="modal.Button" class="kbi-button" @click="modal.joinGuild">Join</component>
        </div>
    </component>`
};

const aboutContentAuthorKeybaseAccountsModal = {
    props: ['modal'],
    template: `<component :is="modal.Modal" class="kbi-modal kbi-about-content-author-keybase-accounts-modal" :class="{'bd-modal-out': modal.closing}" headerText="Content Author Keybase Accounts" @close="modal.close">
        <div slot="body" class="kbi-modal-body">
            <p>Plugins and themes cannot be verified (at least not yet), and the Keybase Integration plugin cannot check if the author's contact information is correct and the author is who they say they are. Contact information in plugins and themes is provided for your convenience. <b>If you do not trust the source of the plugin/theme, do not trust any contact information.</b> (Also don't install untrusted plugins/themes.)</p>
            <h3><b>When I hover over the Keybase icon it says "Keybase + Discord verified".</b></h3>
            <p>"Keybase + Discord verified" is shown in the tooltip for the Keybase account icon when there is also a Discord account in the author's contact information and they've cryptographically proven they're both the same person.</p>
        </div>
    </component>`
};
