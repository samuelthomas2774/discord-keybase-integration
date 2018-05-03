
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

        onstart() {
            Logger.log('Keybase integration started');
            this.patchUserProfileModal();

            CssUtils.injectStyle(`.kbi-modal-body * {
                margin: 0 0 15px;
            }

            .kbi-button {
                padding: 8px 15px;
                border-radius: 3px;
            }

            [data-channel-id="${KEYBASE_PROOFS_CHANNEL}"] svg[name="People"],
            [data-channel-id="${KEYBASE_PROOFS_CHANNEL}"] [class*="membersWrap-"],
            [data-channel-id="441653700260528130"] svg[name="People"],
            [data-channel-id="441653700260528130"] [class*="membersWrap-"] {
                display: none;
            }`);

            // Check if the user is in the proofs server, if not ask them to join
            const proofsGuild = DiscordApi.Guild.fromId(KEYBASE_PROOFS_GUILD);
            if (!proofsGuild)
                this.askUserToJoinGuild();
        }

        onstop() {
            Logger.log('Keybase integration stopped');
            Patcher.unpatchAll();
        }

        askUserToJoinGuild() {
            const modal = Modals.add({
                Modal: Modals.baseComponent,
                Button: CommonComponents.Button,
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
        async getUserProofs(user_id, suppressErrors = true, filter = true) {
            const proofs = [];
            const failedProofs = [];
            const keybaseUsers = new Map();

            for (let message of await this.getUserProofMessages(user_id)) {
                try {
                    const pgp_msg = `-----BEGIN PGP MESSAGE-----\n\n${message.signature}\n-----END PGP MESSAGE-----`;

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

                    const literals = await kbpgpVerify({keyfetch: ring, armored: pgp_msg});
                    Logger.log('Signed message', literals[0].toString());
                    const signer = literals[0].get_data_signer();
                    const signerKeyManager = signer.get_key_manager();
                    const fingerprint = signerKeyManager.get_pgp_fingerprint_str();

                    Logger.log('Fingerprints:', {fingerprints, fingerprint});
                    if (!fingerprints.includes(fingerprint)) {
                        failedProofs.push({fingerprints, fingerprint});
                        continue;
                    }

                    Logger.log('Fingerprint matches!');
                    const proof = JSON.parse(literals[0].toString());

                    if (proof.keybase_proof !== 'discord')
                        throw new Error('`proof.keybase_proof` was not set to `discord`.');
                    if (proof.discord !== user_id)
                        throw new Error('`proof.discord` does not match the user ID.');
                    if (filter && proofs.find(p => p.keybase === proof.keybase))
                        continue;

                    proofs.push(proof);
                } catch (err) {
                    Logger.err(err);
                    failedProofs.push({err});
                }
            }

            if ((!suppressErrors || !proofs.length) && failedProofs.length) {
                throw new Error('All proofs failed.', failedProofs);
            }

            return proofs;
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
                            connectedAccounts.props.children.splice(proof.position || 0, 0, React.createElement('div', {
                                className: 'flex-1xMQg5 flex-1O1GKY horizontal-1ae9ci horizontal-2EEEnY flex-1O1GKY directionRow-3v3tfG justifyStart-2NDFzi alignCenter-1dQNNs noWrap-3jynv6 connectedAccount-36nQx7'
                            }, React.createElement('img', {
                                className: 'connectedAccountIcon-3P3V6F',
                                src: 'https://keybase.io/images/icons/icon-keybase-logo-48.png'
                            }), React.createElement('div', {
                                className: 'connectedAccountNameInner-1phBvE flex-1O1GKY alignCenter-1dQNNs' + ' connectedAccountName-f8AEe2',
                            }, proof.keybase, Api.plugin.renderVerifiedIcon()), React.createElement('a', {
                                href: `https://keybase.io/${proof.keybase}`,
                                target: '_blank'
                            }, React.createElement('div', {
                                className: 'connectedAccountOpenIcon-2cNbq5'
                            }))));
                        }
                    } catch (err) {
                        Logger.err('Error thrown while rendering a UserInfoSection', err);
                    }
                    return retVal;
                }
            };
        }

        renderVerifiedIcon() {
            const Tooltips = WebpackModules.getModule(m => m.hide && m.show && !m.search && !m.submit && !m.search && !m.activateRagingDemon && !m.dismiss);
		    const id = WebpackModules.KeyGenerator();
            let svgElement;

            return React.createElement('svg', {
                className: "connectedAccountVerifiedIcon-3aZz_K",
                name: "Verified",
                width: "24",
                height: "20",
                viewBox: "0 0 20 20",
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
