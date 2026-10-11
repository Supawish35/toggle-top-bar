import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import WorkspaceState from './workspace-state.js';

export default class ToggleTopBarImpl {
    constructor(extension) {
        this.extension = extension;
        this.logger = this.extension.logger || this.extension.getLogger?.('ToggleTopBar') || console;
        this._settings = null;
        this._panelBox = null;
        this._panelHeight = 38;
        this._isPanelHidden = false;
        this._isHoverOverlay = false;
        this._isAnimating = false;
        this._hoverTimeoutId = null;
        this._restoreTimeoutId = null;
        this._workspaceState = null;
        this._windowMaximizeStates = new Map();
        this._maximizeWindowCreatedId = null;

        this._popExtClass = null;
        this._popExt = null;
        this._origMonitorWorkArea = null;
        this._origUpdateDisplay = null;
    }

    _getPanelHeight() {
        if (this._panelBox && this._panelBox.height > 0) {
            this._panelHeight = this._panelBox.height;
        }
        return this._panelHeight || 38;
    }

    async enable() {
        this.logger.log('Enabling extension implementation...');
        this._settings = this.extension.getSettings();
        this._panelBox = Main.layoutManager.panelBox;
        this._panelHeight = this._panelBox?.height || 38;
        this._isPanelHidden = false;
        // Keep the tiling area fixed across workspace changes to avoid retiling.
        // The bar may temporarily overlay windows or leave an empty top strip.
        this._reservePanelSpace = true;
        this._isHoverOverlay = false;
        this._isAnimating = false;

        // The visible panel reserves its normal work area.
        Main.layoutManager.untrackChrome(this._panelBox);
        Main.layoutManager.trackChrome(this._panelBox, { affectsStruts: true });

        this._workspaceState = new WorkspaceState(hidden => {
            if (hidden === this._isPanelHidden) return;
            if (hidden) this._hidePanel({ affectStruts: false, syncWorkspace: false, animateWindows: true });
            else this._restorePanel({ affectStruts: false, syncWorkspace: false, animateWindows: true });
        });
        this._workspaceState.enable();

        // Reset any frozen actor translations from past runs
        this._resetWindowTranslations();
        this._trackMaximizeWindows();
        this._syncMaximizedWindowsWithPanel({ animate: false });

        // Register custom keyboard shortcut
        this._bindShortcut();
        this._shortcutChangedId = this._settings.connect('changed::toggle-shortcut', () => {
            this._rebindShortcut();
        });

        // Overview integration: reveal top bar in Overview, hide when returning
        this._overviewShowingId = Main.overview.connect('showing', () => {
            if (this._isPanelHidden) {
                this._restorePanel({ animate: false, affectStruts: false, syncWorkspace: false, setHiddenState: false });
            }
        });

        this._overviewHidingId = Main.overview.connect('hiding', () => {
            if (this._isPanelHidden) {
                this._workspaceState?.sync();
                if (this._isPanelHidden) {
                    this._hidePanel({ animate: false, affectStruts: false, syncWorkspace: false });
                }
            }
        });

        // Hook into Pop Shell class prototype
        await this._hookPopShell();

        // Setup mouse hover detection at the top screen edge
        this._setupEdgeTrigger();

        // Diagnostics dump
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            try {
                const primaryMon = Main.layoutManager.primaryMonitor;
                const primaryIdx = primaryMon ? primaryMon.index : 0;
                const geom = global.display.get_monitor_geometry(primaryIdx);
                const ws = global.display.get_workspace_manager().get_active_workspace();
                const mutterWorkArea = ws ? ws.get_work_area_for_monitor(primaryIdx) : null;
                const panelH = this._getPanelHeight();

                this.logger.log(`DIAG: geom=[${geom.x}, ${geom.y}, ${geom.width}, ${geom.height}], panelH=${panelH}, mutterWorkArea=[${mutterWorkArea?.x}, ${mutterWorkArea?.y}, ${mutterWorkArea?.width}, ${mutterWorkArea?.height}]`);
                if (this._popExt) {
                    const popWorkArea = this._popExt.monitor_work_area(primaryIdx);
                    this.logger.log(`DIAG: popWorkArea=[${popWorkArea.x}, ${popWorkArea.y}, ${popWorkArea.width}, ${popWorkArea.height}]`);
                    if (this._popExt.auto_tiler) {
                        for (const [id, f] of this._popExt.auto_tiler.forest.forks.iter()) {
                            this.logger.log(`DIAG: fork[${id}]: is_toplevel=${f.is_toplevel}, mon=${f.monitor}, area=[${f.area?.x}, ${f.area?.y}, ${f.area?.width}, ${f.area?.height}], right=${f.right != null}`);
                        }
                    }
                }
                if (ws) {
                    for (const w of ws.list_windows()) {
                        const r = w.get_frame_rect();
                        const a = w.get_compositor_private();
                        this.logger.log(`DIAG: win="${w.get_title()}": frame=[${r.x}, ${r.y}, ${r.width}, ${r.height}], max=${w.is_maximized()}, trans_y=${a?.translation_y}`);
                    }
                }
            } catch (err) {
                this.logger.error(`DIAG error: ${err}`);
            }
            return GLib.SOURCE_REMOVE;
        });

        this.logger.log('Extension enabled successfully.');
    }

    async disable() {
        this.logger.log('Disabling extension implementation...');
        if (this._shortcutChangedId) {
            this._settings.disconnect(this._shortcutChangedId);
            this._shortcutChangedId = null;
        }

        // Remove keybinding
        Main.wm.removeKeybinding('toggle-shortcut');

        // Disconnect overview signals
        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = null;
        }
        if (this._overviewHidingId) {
            Main.overview.disconnect(this._overviewHidingId);
            this._overviewHidingId = null;
        }

        // Clean up hover edge triggers and timers
        this._destroyEdgeTrigger();

        this._workspaceState?.disable();
        this._workspaceState = null;
        this._restoreRememberedMaximizeStates();
        this._untrackMaximizeWindows();

        // Clean up translation_y on all windows
        this._resetWindowTranslations();

        // Restore the shell's normal top bar reservation on disable.
        if (this._isPanelHidden) {
            this._restorePanel({ animate: false });
            this._isPanelHidden = false;
        }
        Main.layoutManager.untrackChrome(this._panelBox);
        this._reservePanelSpace = true;
        Main.layoutManager.trackChrome(this._panelBox, { affectsStruts: true });
        Main.layoutManager._queueUpdateRegions?.();

        // Unhook Pop Shell
        this._unhookPopShell();

        this._settings = null;
        this._panelBox = null;
        this._popExt = null;
        this.logger.log('Extension disabled cleanly.');
    }

    _resetWindowTranslations() {
        const manager = global.display.get_workspace_manager();
        for (let i = 0; i < manager.get_n_workspaces(); i++) {
            for (const win of manager.get_workspace_by_index(i).list_windows()) {
                const actor = win.get_compositor_private();
                if (actor) {
                    actor.remove_all_transitions();
                    actor.scale_x = 1;
                    actor.scale_y = 1;
                    actor.translation_x = 0;
                    actor.translation_y = 0;
                }
                if (this._popExt?.get_window) {
                    try {
                        const popWin = this._popExt.get_window(win);
                        if (popWin?.border) {
                            popWin.border.remove_all_transitions();
                            popWin.border.scale_x = 1;
                            popWin.border.scale_y = 1;
                            popWin.border.translation_x = 0;
                            popWin.border.translation_y = 0;
                        }
                    } catch (_) {}
                }
            }
        }
    }

    _trackMaximizeWindows() {
        const manager = global.display.get_workspace_manager();
        const trackWorkspace = workspace => {
            for (const win of workspace.list_windows()) this._trackMaximizeWindow(win);
        };

        for (let i = 0; i < manager.get_n_workspaces(); i++)
            trackWorkspace(manager.get_workspace_by_index(i));

        this._maximizeWindowCreatedId = global.display.connect('window-created', (_display, win) =>
            this._trackMaximizeWindow(win));
    }

    _trackMaximizeWindow(win) {
        if (this._windowMaximizeStates.has(win)) return;

        const state = { maximized: win.is_maximized(), applying: false, signals: [] };
        const update = () => {
            if (!state.applying) state.maximized = win.is_maximized();
        };
        state.signals.push(
            win.connect('notify::maximized-horizontally', update),
            win.connect('notify::maximized-vertically', update),
            win.connect('unmanaged', () => this._untrackMaximizeWindow(win))
        );
        this._windowMaximizeStates.set(win, state);
    }

    _untrackMaximizeWindow(win) {
        const state = this._windowMaximizeStates.get(win);
        if (!state) return;
        this._windowMaximizeStates.delete(win);
        for (const id of state.signals) {
            try { win.disconnect(id); } catch (_) {}
        }
    }

    _untrackMaximizeWindows() {
        if (this._maximizeWindowCreatedId) {
            global.display.disconnect(this._maximizeWindowCreatedId);
            this._maximizeWindowCreatedId = null;
        }
        for (const win of this._windowMaximizeStates.keys()) this._untrackMaximizeWindow(win);
    }

    _restoreRememberedMaximizeStates() {
        for (const [win, state] of this._windowMaximizeStates) {
            if (!state.maximized || win.is_maximized()) continue;
            state.applying = true;
            win.maximize(Meta.MaximizeFlags.BOTH);
            state.applying = false;
        }
    }

    _syncMaximizedWindowsWithPanel({ animate = false } = {}) {
        const workspace = global.display.get_workspace_manager().get_active_workspace();
        if (!workspace) return;

        for (const win of workspace.list_windows()) {
            const state = this._windowMaximizeStates.get(win);
            if (!state) continue;

            const shouldMaximize = state.maximized && this._isPanelHidden;
            if (shouldMaximize === win.is_maximized()) continue;

            const actor = win.get_compositor_private();
            const oldRect = animate && actor ? win.get_frame_rect() : null;

            state.applying = true;
            if (shouldMaximize)
                win.maximize(Meta.MaximizeFlags.BOTH);
            else
                win.unmaximize(Meta.MaximizeFlags.BOTH);
            state.applying = false;

            if (oldRect && actor) {
                const newRect = win.get_frame_rect();
                if (newRect.width > 0 && newRect.height > 0 &&
                    (oldRect.width !== newRect.width || oldRect.height !== newRect.height ||
                     oldRect.x !== newRect.x || oldRect.y !== newRect.y)) {
                    actor.remove_all_transitions();
                    actor.scale_x = oldRect.width / newRect.width;
                    actor.scale_y = oldRect.height / newRect.height;
                    actor.translation_x = oldRect.x + oldRect.width / 2 - newRect.x - newRect.width / 2;
                    actor.translation_y = oldRect.y + oldRect.height / 2 - newRect.y - newRect.height / 2;
                    actor.ease({
                        scale_x: 1,
                        scale_y: 1,
                        translation_x: 0,
                        translation_y: 0,
                        duration: 220,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                }
            }
        }
    }

    /* -------------------------------------------------------------
     *  Keybinding
     * ------------------------------------------------------------- */
    _bindShortcut() {
        Main.wm.addKeybinding(
            'toggle-shortcut',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this.togglePanel()
        );
    }

    _rebindShortcut() {
        Main.wm.removeKeybinding('toggle-shortcut');
        this._bindShortcut();
    }

    togglePanel() {
        this.logger.log(`togglePanel called: current isPanelHidden=${this._isPanelHidden}`);
        if (this._isPanelHidden) {
            this._restorePanel();
        } else if (this._workspaceState?.activeWorkspaceIsEmpty()) {
            this._workspaceState.setHidden(false);
        } else {
            this._hidePanel();
        }
    }

    /* -------------------------------------------------------------
     *  Panel Visibility & Work Area Struts
     * ------------------------------------------------------------- */
    _hidePanel({ animate = true, affectStruts = true, syncWorkspace = true, animateWindows = true } = {}) {
        if (!this._panelBox) return;

        this._isPanelHidden = true;
        if (syncWorkspace) this._workspaceState?.setHidden(true);
        this._syncMaximizedWindowsWithPanel({ animate: animate && animateWindows });
        this._isHoverOverlay = false;
        this._isAnimating = true;

        // Only cancel the retry when changing the reserved work area. A workspace
        // transition keeps the same area, so any pending retry remains valid.
        if (affectStruts && this._popExt && this._popExt.workareas_update !== null) {
            GLib.source_remove(this._popExt.workareas_update);
            this._popExt.workareas_update = null;
        }

        const duration = animate ? 220 : 0;
        const panelHeight = this._getPanelHeight();
        const mode = Clutter.AnimationMode.EASE_OUT_QUAD;

        if (affectStruts) {
            this._reservePanelSpace = false;
            Main.layoutManager.untrackChrome(this._panelBox);
            Main.layoutManager.trackChrome(this._panelBox, { affectsStruts: false });
        }

        if (animate) {
            this._panelBox.remove_all_transitions();
            this._panelBox.ease({
                translation_y: -panelHeight,
                duration,
                mode,
                onComplete: () => {
                    if (this._isPanelHidden) {
                        this._panelBox.hide();
                    }
                    this._isAnimating = false;
                },
            });
        } else {
            this._panelBox.hide();
            this._panelBox.translation_y = -panelHeight;
            this._isAnimating = false;
        }

        if (affectStruts) Main.layoutManager._queueUpdateRegions?.();
        this._isAnimating = false;
    }

    _restorePanel({ animate = true, affectStruts = true, syncWorkspace = true, setHiddenState = true, animateWindows = true } = {}) {
        if (!this._panelBox) return;

        if (setHiddenState) this._isPanelHidden = false;
        if (syncWorkspace) this._workspaceState?.setHidden(false);
        this._syncMaximizedWindowsWithPanel({ animate: animate && animateWindows });
        this._isHoverOverlay = false;
        this._isAnimating = true;

        // Keep pending retries when this is only a visual workspace transition;
        // they still target the unchanged reserved work area.
        if (affectStruts && this._popExt && this._popExt.workareas_update !== null) {
            GLib.source_remove(this._popExt.workareas_update);
            this._popExt.workareas_update = null;
        }

        const duration = animate ? 220 : 0;
        const panelHeight = this._getPanelHeight();
        const mode = Clutter.AnimationMode.EASE_OUT_QUAD;

        this._panelBox.show();
        this._panelBox.opacity = 255;

        if (affectStruts) {
            this._reservePanelSpace = true;
            Main.layoutManager.untrackChrome(this._panelBox);
            Main.layoutManager.trackChrome(this._panelBox, { affectsStruts: true });
        }

        if (animate) {
            this._panelBox.remove_all_transitions();
            this._panelBox.translation_y = -panelHeight;
            this._panelBox.ease({
                translation_y: 0,
                duration,
                mode,
                onComplete: () => {
                    this._isAnimating = false;
                    if (affectStruts && !this._isPanelHidden) {
                        Main.layoutManager._queueUpdateRegions();
                    }
                },
            });
        } else {
            this._panelBox.remove_all_transitions();
            this._panelBox.translation_y = 0;
            this._isAnimating = false;
            if (affectStruts) {
                Main.layoutManager._queueUpdateRegions();
            }
        }

        if (affectStruts) this._isAnimating = false;
    }

    /* -------------------------------------------------------------
     *  Pop Shell Hooking & Workarea Management
     * ------------------------------------------------------------- */
    async _hookPopShell() {
        try {
            const popModule = await import('file:///usr/share/gnome-shell/extensions/pop-shell@system76.com/extension.js');
            if (!popModule?.Ext) {
                this.logger.warn('Pop Shell Ext class not found in module');
                return;
            }

            this._popExtClass = popModule.Ext;
            const self = this;

            // 1. Hook Ext.prototype.monitor_work_area
            this._origMonitorWorkArea = this._popExtClass.prototype.monitor_work_area;
            this._popExtClass.prototype.monitor_work_area = function(monitor) {
                if (!self._popExt) {
                    self._popExt = this;
                }

                const primaryIdx = Main.layoutManager.primaryMonitor?.index ?? 0;
                if (monitor === primaryIdx) {
                    const stack = new Error().stack || '';
                    const geom = global.display.get_monitor_geometry(monitor);
                    if (geom) {
                        const Rect = this.monitor_area(monitor).constructor;

                        if (stack.includes('primary_display_ready')) {
                            // Pop Shell's primary_display_ready requires (area.height !== work_area.height)
                            return new Rect([geom.x, geom.y, geom.width, geom.height - 1]);
                        }
                        if (!self._reservePanelSpace)
                            return new Rect([geom.x, geom.y, geom.width, geom.height]);

                        const panelHeight = self._getPanelHeight();
                        return new Rect([geom.x, geom.y + panelHeight, geom.width, geom.height - panelHeight]);
                    }
                }

                return self._origMonitorWorkArea.call(this, monitor);
            };

            // 2. Hook Ext.prototype.update_display_configuration
            this._origUpdateDisplay = this._popExtClass.prototype.update_display_configuration;
            this._popExtClass.prototype.update_display_configuration = function(workareas_only) {
                if (!self._popExt) {
                    self._popExt = this;
                }
                if (self._isAnimating) {
                    return;
                }
                return self._origUpdateDisplay.call(this, workareas_only);
            };

            this.logger.log('Pop Shell hooks installed successfully');

            // Trigger display workarea update so Pop Shell immediately invokes its hook and passes its instance
            try {
                global.display.emit('workareas-changed');
            } catch (err) {
                this.logger.warn(`Could not emit workareas-changed: ${err}`);
            }
        } catch (err) {
            this.logger.error(`Failed to hook Pop Shell: ${err}`);
        }
    }

    _unhookPopShell() {
        if (this._popExtClass) {
            if (this._origMonitorWorkArea) {
                this._popExtClass.prototype.monitor_work_area = this._origMonitorWorkArea;
                this._origMonitorWorkArea = null;
            }
            if (this._origUpdateDisplay) {
                this._popExtClass.prototype.update_display_configuration = this._origUpdateDisplay;
                this._origUpdateDisplay = null;
            }
            this._popExtClass = null;
        }
    }

    /* -------------------------------------------------------------
     *  Mouse Hover Edge Barrier Trigger (Auto-reveal)
     * ------------------------------------------------------------- */
    _setupEdgeTrigger() {
        const primary = Main.layoutManager.primaryMonitor;
        if (!primary) return;

        this._edgeActor = new Clutter.Actor({
            name: 'top-bar-edge-trigger',
            x: primary.x,
            y: primary.y,
            width: primary.width,
            height: 2,
            reactive: true,
            opacity: 0,
        });

        Main.layoutManager.addChrome(this._edgeActor, { affectsStruts: false });

        this._edgeActor.connect('enter-event', () => {
            if (!this._isPanelHidden || !this._settings.get_boolean('mouse-hover-reveal')) {
                return Clutter.EVENT_PROPAGATE;
            }

            const delay = this._settings.get_int('hover-delay') || 250;
            if (this._hoverTimeoutId) {
                GLib.source_remove(this._hoverTimeoutId);
            }

            this._hoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._hoverTimeoutId = null;
                this._showHoverOverlay();
                return GLib.SOURCE_REMOVE;
            });

            return Clutter.EVENT_PROPAGATE;
        });

        this._panelLeaveId = this._panelBox.connect('leave-event', () => {
            if (!this._isPanelHidden || !this._isHoverOverlay) {
                return Clutter.EVENT_PROPAGATE;
            }

            if (this._restoreTimeoutId) {
                GLib.source_remove(this._restoreTimeoutId);
            }

            this._restoreTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                this._restoreTimeoutId = null;
                if (this._isPanelHidden && this._isHoverOverlay) {
                    if (Main.panel?.menuManager?.activeMenu) {
                        return GLib.SOURCE_REMOVE;
                    }
                    this._hideHoverOverlay();
                }
                return GLib.SOURCE_REMOVE;
            });

            return Clutter.EVENT_PROPAGATE;
        });
    }

    _showHoverOverlay() {
        this._isHoverOverlay = true;
        this._panelBox.show();
        this._panelBox.opacity = 255;
        this._panelBox.remove_all_transitions();
        this._panelBox.ease({
            translation_y: 0,
            duration: 180,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _hideHoverOverlay() {
        this._isHoverOverlay = false;
        const panelHeight = this._getPanelHeight();
        this._panelBox.remove_all_transitions();
        this._panelBox.ease({
            translation_y: -panelHeight,
            duration: 180,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (this._isPanelHidden && !this._isHoverOverlay) {
                    this._panelBox.hide();
                }
            },
        });
    }

    _destroyEdgeTrigger() {
        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = null;
        }
        if (this._restoreTimeoutId) {
            GLib.source_remove(this._restoreTimeoutId);
            this._restoreTimeoutId = null;
        }
        if (this._edgeActor) {
            Main.layoutManager.removeChrome(this._edgeActor);
            this._edgeActor.destroy();
            this._edgeActor = null;
        }
        if (this._panelLeaveId && this._panelBox) {
            this._panelBox.disconnect(this._panelLeaveId);
            this._panelLeaveId = null;
        }
    }
}
