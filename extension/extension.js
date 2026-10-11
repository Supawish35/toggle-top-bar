import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

export default class ToggleTopBarExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._impl = null;
        this.logger = this.getLogger('ToggleTopBar');
    }

    async enable() {
        try {
            const url = `${this.metadata.dir.get_uri()}/impl.js?v=${Date.now()}`;
            this.logger.log(`Loading implementation from ${url}`);
            const { default: ToggleTopBarImpl } = await import(url);
            this._impl = new ToggleTopBarImpl(this);
            await this._impl.enable();
        } catch (err) {
            this.logger.error(`Error enabling extension: ${err}`);
        }
    }

    async disable() {
        try {
            if (this._impl) {
                await this._impl.disable();
                this._impl = null;
            }
        } catch (err) {
            console.error(`[ToggleTopBar Loader] Error disabling extension: ${err}`);
        }
    }
}
