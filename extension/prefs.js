import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Interactive Shortcut Capture Dialog
class ShortcutDialog extends Adw.Dialog {
    static {
        GObject.registerClass({
            Signals: {
                'shortcut-entered': {
                    param_types: [GObject.TYPE_STRING],
                },
            },
        }, this);
    }

    constructor() {
        super({
            title: _('Set Shortcut'),
            content_width: 380,
            content_height: 240,
        });

        this._controller = new Gtk.EventControllerKey({
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        });
        this.add_controller(this._controller);
        this._controller.connect('key-pressed', (_src, keyval, keycode, state) => {
            return this._onKeyPressed(keyval, keycode, state);
        });

        const toolbarView = new Adw.ToolbarView();
        const headerBar = new Adw.HeaderBar();
        toolbarView.add_top_bar(headerBar);
        this.set_child(toolbarView);

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            spacing: 16,
            margin_top: 24,
            margin_bottom: 24,
            margin_start: 24,
            margin_end: 24,
        });
        toolbarView.set_content(box);

        const promptLabel = new Gtk.Label({
            label: _('Press any key combination...'),
            css_classes: ['title-2'],
        });
        box.append(promptLabel);

        const hintBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            halign: Gtk.Align.CENTER,
        });
        box.append(hintBox);

        const backLabel = new Gtk.Label({
            label: _('Press Backspace to reset to default (<Alt>f)'),
            css_classes: ['dim-label'],
        });
        hintBox.append(backLabel);

        const escLabel = new Gtk.Label({
            label: _('Press Esc to cancel'),
            css_classes: ['dim-label'],
        });
        hintBox.append(escLabel);
    }

    _onKeyPressed(keyval, keycode, state) {
        const mask = state & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;

        // Escape cancels dialog
        if (keyval === Gdk.KEY_Escape && mask === 0) {
            this.close();
            return Gdk.EVENT_STOP;
        }

        // Backspace resets to default
        if (keyval === Gdk.KEY_BackSpace && mask === 0) {
            this.emit('shortcut-entered', '<Alt>f');
            this.close();
            return Gdk.EVENT_STOP;
        }

        // Check if accelerator is valid
        if (!Gtk.accelerator_valid(keyval, mask)) {
            return Gdk.EVENT_STOP;
        }

        const display = Gdk.Display.get_default();
        if (!display) return Gdk.EVENT_STOP;

        const shortcut = Gtk.accelerator_name_with_keycode(display, keyval, keycode, mask);
        if (shortcut) {
            this.emit('shortcut-entered', shortcut);
            this.close();
        }

        return Gdk.EVENT_STOP;
    }
}

export default class ToggleTopBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-other-symbolic',
        });
        window.add(page);

        // Group 1: Keyboard Shortcut
        const keyGroup = new Adw.PreferencesGroup({
            title: _('Keyboard Shortcut'),
            description: _('Configure the hotkey to toggle the top bar'),
        });
        page.add(keyGroup);

        const shortcutRow = new Adw.ActionRow({
            title: _('Toggle Top Bar Shortcut'),
            subtitle: _('Click to change shortcut key'),
            activatable: true,
        });

        const currentShortcuts = settings.get_strv('toggle-shortcut');
        const currentBinding = (currentShortcuts && currentShortcuts.length > 0)
            ? currentShortcuts[0]
            : '<Super>b';

        const shortcutLabel = new Gtk.ShortcutLabel({
            accelerator: currentBinding,
            valign: Gtk.Align.CENTER,
        });
        shortcutRow.add_suffix(shortcutLabel);

        // Edit button suffix
        const editButton = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Change shortcut'),
        });
        shortcutRow.add_suffix(editButton);

        const openShortcutDialog = () => {
            const dialog = new ShortcutDialog();
            dialog.connect('shortcut-entered', (_d, newShortcut) => {
                settings.set_strv('toggle-shortcut', [newShortcut]);
                shortcutLabel.set_accelerator(newShortcut);
            });
            dialog.present(window);
        };

        shortcutRow.connect('activated', openShortcutDialog);
        editButton.connect('clicked', openShortcutDialog);

        // Listen for external gsettings changes
        settings.connect('changed::toggle-shortcut', () => {
            const val = settings.get_strv('toggle-shortcut');
            if (val && val.length > 0) {
                shortcutLabel.set_accelerator(val[0]);
            }
        });

        keyGroup.add(shortcutRow);

        // Group 2: Appearance & Behavior
        const behaviorGroup = new Adw.PreferencesGroup({
            title: _('Behavior'),
            description: _('Configure top bar auto-hide and reveal behaviors'),
        });
        page.add(behaviorGroup);

        // Row: Mouse Hover Auto-Reveal
        const hoverSwitch = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
            active: settings.get_boolean('mouse-hover-reveal'),
        });
        settings.bind('mouse-hover-reveal', hoverSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);

        const hoverRow = new Adw.ActionRow({
            title: _('Auto-reveal on mouse hover'),
            subtitle: _('Temporarily slide down top bar when cursor touches top screen edge'),
            activatable_widget: hoverSwitch,
        });
        hoverRow.add_suffix(hoverSwitch);
        behaviorGroup.add(hoverRow);

        // Row: Hover Delay
        const delayAdjustment = new Gtk.Adjustment({
            lower: 50,
            upper: 1000,
            step_increment: 50,
            page_increment: 100,
            value: settings.get_int('hover-delay'),
        });
        const delaySpin = new Gtk.SpinButton({
            adjustment: delayAdjustment,
            valign: Gtk.Align.CENTER,
        });
        settings.bind('hover-delay', delaySpin, 'value', Gio.SettingsBindFlags.DEFAULT);

        const delayRow = new Adw.ActionRow({
            title: _('Hover reveal delay (ms)'),
            subtitle: _('Delay before the top bar slides down (avoids conflict with browser tabs)'),
            activatable_widget: delaySpin,
        });
        delayRow.add_suffix(delaySpin);
        behaviorGroup.add(delayRow);
    }
}
