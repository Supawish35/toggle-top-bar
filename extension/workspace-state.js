import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export default class WorkspaceState {
    constructor(onVisibilityChanged) {
        this._onVisibilityChanged = onVisibilityChanged;
        this._manager = null;
        this._activeWorkspace = null;
        this._hidden = false;
        this._states = new Map();
        this._windowSignals = new Map();
        this._syncId = null;
    }

    enable() {
        this._manager = global.display.get_workspace_manager();
        this._activeWorkspace = this._manager.get_active_workspace();
        if (this._activeWorkspace) this._states.set(this._activeWorkspace, false);

        this._workspaceChangedId = this._manager.connect('active-workspace-changed', () => this.sync());
        this._workspaceRemovedId = this._manager.connect('workspace-removed', () => this._prune());
        this._windowCreatedId = global.display.connect('window-created', (_display, win) => {
            this._trackWindow(win);
            this._scheduleSync();
        });

        for (let i = 0; i < this._manager.get_n_workspaces(); i++) {
            for (const win of this._manager.get_workspace_by_index(i).list_windows()) {
                this._trackWindow(win);
            }
        }
    }

    setHidden(hidden) {
        this._hidden = hidden;
        if (this._activeWorkspace) this._states.set(this._activeWorkspace, hidden);
    }

    activeWorkspaceIsEmpty() {
        return this._hasNoNormalWindows(this._activeWorkspace);
    }

    sync() {
        this._sync();
    }

    disable() {
        if (!this._manager) return;

        this._manager.disconnect(this._workspaceChangedId);
        this._manager.disconnect(this._workspaceRemovedId);
        global.display.disconnect(this._windowCreatedId);
        if (this._syncId) GLib.source_remove(this._syncId);
        for (const win of this._windowSignals.keys()) this._untrackWindow(win);

        this._states.clear();
        this._manager = null;
        this._activeWorkspace = null;
        this._onVisibilityChanged = null;
    }

    _trackWindow(win) {
        if (this._windowSignals.has(win)) return;
        const schedule = () => this._scheduleSync();
        this._windowSignals.set(win, [
            win.connect('unmanaged', () => {
                this._untrackWindow(win);
                schedule();
            }),
            win.connect('workspace-changed', schedule),
            win.connect('position-changed', schedule),
            win.connect('notify::minimized', schedule),
        ]);
    }

    _untrackWindow(win) {
        const ids = this._windowSignals.get(win);
        if (!ids) return;
        this._windowSignals.delete(win);
        for (const id of ids) {
            try { win.disconnect(id); } catch (_) {}
        }
    }

    _scheduleSync() {
        if (this._syncId) return;
        this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._syncId = null;
            this.sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        const workspace = this._manager?.get_active_workspace();
        if (!workspace) return;

        if (this._activeWorkspace && this._activeWorkspace !== workspace) {
            this._states.set(this._activeWorkspace, this._hidden);
        }
        this._activeWorkspace = workspace;

        if (!this._states.has(workspace)) this._states.set(workspace, false);
        if (this._hasNoNormalWindows(workspace)) this._states.set(workspace, false);

        this._hidden = this._states.get(workspace);
        this._onVisibilityChanged?.(this._hidden);
    }

    _hasNoNormalWindows(workspace) {
        if (!workspace) return true;
        const primaryMonitor = Main.layoutManager.primaryMonitor?.index ?? 0;
        return !workspace.list_windows().some(win =>
            !win.is_override_redirect() &&
            !win.is_attached_dialog() &&
            !win.minimized &&
            win.get_window_type() === Meta.WindowType.NORMAL &&
            win.get_monitor() === primaryMonitor
        );
    }

    _prune() {
        const workspaces = new Set();
        for (let i = 0; i < this._manager.get_n_workspaces(); i++) {
            workspaces.add(this._manager.get_workspace_by_index(i));
        }
        for (const workspace of this._states.keys()) {
            if (!workspaces.has(workspace)) this._states.delete(workspace);
        }
    }
}
