import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

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
        this._isHoverOverlay = false;
        this._isAnimating = false;

        // Reset any frozen actor translations from past runs
        this._resetWindowTranslations();

        // Register custom keyboard shortcut
        this._bindShortcut();
        this._shortcutChangedId = this._settings.connect('changed::toggle-shortcut', () => {
            this._rebindShortcut();
        });

        // Overview integration: reveal top bar in Overview, hide when returning
        this._overviewShowingId = Main.overview.connect('showing', () => {
            if (this._isPanelHidden) {
                this._restorePanel(false, false);
            }
        });

        this._overviewHidingId = Main.overview.connect('hiding', () => {
            if (this._isPanelHidden) {
                this._hidePanel(false);
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

        // Clean up translation_y on all windows
        this._resetWindowTranslations();

        // Restore top bar if currently hidden
        if (this._isPanelHidden) {
            this._restorePanel(false, true);
            this._isPanelHidden = false;
        }

        // Unhook Pop Shell
        this._unhookPopShell();

        this._settings = null;
        this._panelBox = null;
        this._popExt = null;
        this.logger.log('Extension disabled cleanly.');
    }

    _resetWindowTranslations() {
        const workspace = global.display.get_workspace_manager().get_active_workspace();
        if (!workspace) return;
        for (const win of workspace.list_windows()) {
            const actor = win.get_compositor_private();
            if (actor) {
                actor.remove_all_transitions();
                actor.translation_y = 0;
            }
            if (this._popExt?.get_window) {
                try {
                    const popWin = this._popExt.get_window(win);
                    if (popWin?.border) {
                        popWin.border.remove_all_transitions();
                        popWin.border.translation_y = 0;
                    }
                } catch (_) {}
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
            this._restorePanel(true, true);
        } else {
            this._hidePanel(true);
        }
    }

    /* -------------------------------------------------------------
     *  Panel Visibility & Work Area Struts
     * ------------------------------------------------------------- */
    _hidePanel(animate = true) {
        if (!this._panelBox) return;

        this._isPanelHidden = true;
        this._isHoverOverlay = false;
        this._isAnimating = true;

        // Cancel any pending workarea retry timeouts in Pop Shell
        if (this._popExt && this._popExt.workareas_update !== null) {
            GLib.source_remove(this._popExt.workareas_update);
            this._popExt.workareas_update = null;
        }

        const duration = animate ? 220 : 0;
        const panelHeight = this._getPanelHeight();
        const mode = Clutter.AnimationMode.EASE_OUT_QUAD;

        // Reset any stale translations before measuring
        const primaryIdx = Main.layoutManager.primaryMonitor?.index ?? 0;
        const workspace = global.display.get_workspace_manager().get_active_workspace();
        const windows = workspace ? workspace.list_windows().filter(w => {
            return !w.is_override_redirect() &&
                   !w.is_attached_dialog() &&
                   !w.minimized &&
                   w.get_window_type() === Meta.WindowType.NORMAL &&
                   w.get_monitor() === primaryIdx;
        }) : [];

        for (const win of windows) {
            const actor = win.get_compositor_private();
            if (actor) {
                actor.remove_all_transitions();
                actor.translation_y = 0;
            }
        }

        // Capture current window positions before retiling
        const oldRects = new Map();
        if (animate) {
            for (const win of windows) {
                oldRects.set(win, win.get_frame_rect());
            }
        }

        // Untrack panelBox struts so Mutter updates work areas to full monitor
        Main.layoutManager.untrackChrome(this._panelBox);
        Main.layoutManager.trackChrome(this._panelBox, { affectsStruts: false });

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

        // Retile immediately in lockstep with the panel animation
        this._retileAll();

        // Windows snap immediately (no slide) so their bottoms don't lag behind
    }

    _restorePanel(animate = true, affectStruts = true) {
        if (!this._panelBox) return;

        if (affectStruts) {
            this._isPanelHidden = false;
        }
        this._isHoverOverlay = false;
        this._isAnimating = true;

        // Cancel any pending workarea retry timeouts in Pop Shell
        if (this._popExt && this._popExt.workareas_update !== null) {
            GLib.source_remove(this._popExt.workareas_update);
            this._popExt.workareas_update = null;
        }

        const duration = animate ? 220 : 0;
        const panelHeight = this._getPanelHeight();
        const mode = Clutter.AnimationMode.EASE_OUT_QUAD;

        // Reset any stale translations before measuring
        const primaryIdx = Main.layoutManager.primaryMonitor?.index ?? 0;
        const workspace = global.display.get_workspace_manager().get_active_workspace();
        const windows = workspace ? workspace.list_windows().filter(w => {
            return !w.is_override_redirect() &&
                   !w.is_attached_dialog() &&
                   !w.minimized &&
                   w.get_window_type() === Meta.WindowType.NORMAL &&
                   w.get_monitor() === primaryIdx;
        }) : [];

        for (const win of windows) {
            const actor = win.get_compositor_private();
            if (actor) {
                actor.remove_all_transitions();
                actor.translation_y = 0;
            }
        }

        // Capture current window positions before retiling
        const oldRects = new Map();
        if (animate && affectStruts) {
            for (const win of windows) {
                oldRects.set(win, win.get_frame_rect());
            }
        }

        this._panelBox.show();
        this._panelBox.opacity = 255;

        if (affectStruts) {
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

        if (affectStruts) {
            this._retileAll();
        }
    }

    _animateWindows(windows, oldRects, duration) {
        const mode = Clutter.AnimationMode.EASE_OUT_QUAD;
        for (const win of windows) {
            const oldRect = oldRects.get(win);
            if (!oldRect) continue;

            const newRect = win.get_frame_rect();
            const dy = oldRect.y - newRect.y;
            this.logger.log(`_animateWindows: win="${win.get_title()}", old=[${oldRect.x}, ${oldRect.y}, ${oldRect.width}, ${oldRect.height}], new=[${newRect.x}, ${newRect.y}, ${newRect.width}, ${newRect.height}], dy=${dy}`);

            const actor = win.get_compositor_private();
            if (actor) {
                actor.remove_all_transitions();
                if (Math.abs(dy) > 0) {
                    actor.translation_y = dy;
                    actor.ease({
                        translation_y: 0,
                        duration,
                        mode,
                        onComplete: () => {
                            actor.translation_y = 0;
                        },
                    });
                } else {
                    actor.translation_y = 0;
                }
            }

            if (this._popExt?.get_window) {
                try {
                    const popWin = this._popExt.get_window(win);
                    if (popWin?.border) {
                        popWin.border.remove_all_transitions();
                        if (Math.abs(dy) > 0) {
                            popWin.border.translation_y = dy;
                            popWin.border.ease({
                                translation_y: 0,
                                duration,
                                mode,
                                onComplete: () => {
                                    popWin.border.translation_y = 0;
                                },
                            });
                        } else {
                            popWin.border.translation_y = 0;
                        }
                    }
                } catch (_) {}
            }
        }
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
                        const panelHeight = self._getPanelHeight();

                        if (self._isPanelHidden) {
                            if (stack.includes('primary_display_ready')) {
                                // Pop Shell's primary_display_ready requires (area.height !== work_area.height)
                                return new Rect([geom.x, geom.y, geom.width, geom.height - 1]);
                            }
                            return new Rect([geom.x, geom.y, geom.width, geom.height]);
                        } else {
                            if (stack.includes('primary_display_ready')) {
                                return new Rect([geom.x, geom.y + panelHeight, geom.width, geom.height - panelHeight]);
                            }
                            return new Rect([geom.x, geom.y + panelHeight, geom.width, geom.height - panelHeight]);
                        }
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

    _retileAll() {
        const primaryMon = Main.layoutManager.primaryMonitor;
        const primaryIdx = primaryMon ? primaryMon.index : 0;
        const geom = global.display.get_monitor_geometry(primaryIdx);
        const panelHeight = this._getPanelHeight();
        this.logger.log(`_retileAll: isPanelHidden=${this._isPanelHidden}, panelHeight=${panelHeight}`);

        // Queue Mutter layout update
        if (Main.layoutManager._queueUpdateRegions) {
            Main.layoutManager._queueUpdateRegions();
        }

        // Retile Pop Shell trees
        if (this._popExt) {
            try {
                if (this._popExt.workareas_update !== null) {
                    GLib.source_remove(this._popExt.workareas_update);
                    this._popExt.workareas_update = null;
                }

                // Trigger Pop Shell's native display configuration update
                this._popExt.update_display_configuration(true);

                if (this._popExt.auto_tiler) {
                    for (const fork of this._popExt.auto_tiler.forest.forks.values()) {
                        if (!fork.is_toplevel || fork.monitor !== primaryIdx) continue;

                        const Rect = fork.area.constructor;
                        const area = this._isPanelHidden
                            ? new Rect([geom.x, geom.y, geom.width, geom.height])
                            : new Rect([geom.x, geom.y + panelHeight, geom.width, geom.height - panelHeight]);

                        fork.smart_gapped = false;
                        fork.set_area(area.clone());
                        this._popExt.auto_tiler.update_toplevel(
                            this._popExt,
                            fork,
                            fork.monitor,
                            this._popExt.settings.smart_gaps()
                        );
                    }
                }

                // Synchronously flush all pending window movements queued by Pop Shell
                // so windows are moved immediately and Pop Shell's idle queue won't cancel our transitions!
                if (this._popExt.movements) {
                    for (const [entity, movement] of Array.from(this._popExt.movements.iter())) {
                        const popWin = this._popExt.windows.get(entity);
                        if (!popWin) continue;
                        this._popExt.movements.remove(entity);
                        const { x, y, width, height } = movement;
                        this.logger.log(`_retileAll: flush popWin="${popWin.name(this._popExt)}", target=[${x}, ${y}, ${width}, ${height}]`);
                        popWin.meta.move_resize_frame(true, x, y, width, height);
                        popWin.meta.move_frame(true, x, y);
                        if (popWin.meta.appears_focused) {
                            try { popWin.update_border_layout?.(); } catch (_) {}
                        }
                    }
                }

                return;
            } catch (err) {
                this.logger.error(`Error re-tiling Pop Shell: ${err}`);
            }
        }

        // Fallback for non-pop-shell windows
        this._fallbackResizeWindows(this._isPanelHidden, geom);
    }

    _fallbackResizeWindows(hidden, geom) {
        if (!geom) return;
        const panelHeight = this._getPanelHeight();
        const workspace = global.display.get_workspace_manager().get_active_workspace();
        if (!workspace) return;

        const windows = workspace.list_windows().filter(w => {
            return !w.is_override_redirect() &&
                   !w.is_attached_dialog() &&
                   !w.minimized &&
                   w.get_window_type() === Meta.WindowType.NORMAL &&
                   w.get_monitor() === (Main.layoutManager.primaryMonitor?.index ?? 0);
        });

        for (const win of windows) {
            const frame = win.get_frame_rect();
            if (hidden) {
                win.move_resize_frame(true, frame.x, geom.y, frame.width, geom.height);
            } else {
                win.move_resize_frame(true, frame.x, geom.y + panelHeight, frame.width, geom.height - panelHeight);
            }
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
