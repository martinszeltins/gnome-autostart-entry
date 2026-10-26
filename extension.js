/*
 * Copyright (C) 2026 martinszeltins
 *
 * Autostart Entry for GNOME Shell 45+
 *
 * The menu injection and the placement of the menu item under "App Details"
 * are adapted from Edit Desktop Files by Dannflower, licensed under
 * GPL-2.0-or-later:
 * https://github.com/Dannflower/edit-desktop-files
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import GLib from 'gi://GLib'
import Gio from 'gi://Gio'
import {Extension, InjectionManager, gettext} from 'resource:///org/gnome/shell/extensions/extension.js'
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js'
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js'

/*
* Adds an "Autostart" item to the menu that appears when right-clicking an
* app icon in the app grid or dash. The item shows a check mark when that
* app is set to start at login, and choosing it adds or removes the entry
* in ~/.config/autostart.
*/
const DESKTOP_GROUP = 'Desktop Entry'
const KEPT_KEYS = [
    'Type',
    'Name',
    'Comment',
    'Icon',
    'Exec',
    'TryExec',
    'DBusActivatable',
    'Terminal',
    'Path',
]
const FIELD_CODES = 'fFuUdDnNickvm'

export default class AutostartEntryExtension extends Extension {
    enable() {
        this._injectionManager = new InjectionManager()
        this._modifiedMenus = []
        this._addedMenuItems = []

        // Resolve the translation here. gettext() inside the injected method
        // would look up the string in GNOME Shell's own catalog.
        let localizedAutostartStr = gettext('Autostart')
        let extensionName = this.metadata.name

        this._injectionManager.overrideMethod(AppMenu.prototype, 'open',
            originalMethod => {
                const moveMenuItemAfter = this.moveMenuItemAfter
                const modifiedMenus = this._modifiedMenus
                const addedMenuItems = this._addedMenuItems

                return function (...args) {
                    const appInfo = this._app?.app_info
                    if (!appInfo || !isSafeDesktopId(desktopId(appInfo)))
                        return originalMethod.call(this, ...args)

                    const boundMoveMenuItemAfter = moveMenuItemAfter.bind(this)

                    if (!this._autostartEntryExtensionMenuItem) {
                        let menuItem = this.addAction(localizedAutostartStr, () => {
                            let currentAppInfo = this._app?.app_info
                            if (!currentAppInfo)
                                return

                            let wasEnabled = isAutostartEnabled(currentAppInfo)
                            if (!setAutostartEnabled(extensionName, currentAppInfo, !wasEnabled))
                                return

                            let enabled = isAutostartEnabled(currentAppInfo)
                            menuItem.setOrnament(enabled ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE)
                        })

                        // _('App Details') is GNOME Shell's translation, not this extension's.
                        boundMoveMenuItemAfter(menuItem, _('App Details'))

                        this._autostartEntryExtensionMenuItem = menuItem
                        addedMenuItems.push(menuItem)
                    }

                    let enabled = isAutostartEnabled(appInfo)
                    this._autostartEntryExtensionMenuItem.setOrnament(
                        enabled ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE)

                    if (!modifiedMenus.includes(this))
                        modifiedMenus.push(this)

                    return originalMethod.call(this, ...args)
                }
            })
    }

    /**
     * Move the MenuItem to be after the MenuItem with the given afterLabel.
     * If the MenuItem with the given afterLabel does not exist, the MenuItem will not be moved and false will be returned.
     * Otherwise, the MenuItem will be moved and true will be returned.
     * @param {Object} menuItemToMove - The MenuItem to be moved
     * @param {string} afterLabel - The label of the MenuItem after which the MenuItem should be moved
     * @returns {boolean} - Returns true if the MenuItem was moved, false if no such MenuItem exists with the given label
     */
    moveMenuItemAfter(menuItemToMove, afterLabel) {
        let menuItems = this._getMenuItems()
        for (let i = 0; i < menuItems.length; i++) {
            let menuItem = menuItems[i]
            if (menuItem.label) {
                if (menuItem.label.text == afterLabel) {
                    this.moveMenuItem(menuItemToMove, i + 1)
                    return true
                }
            }
        }

        return false
    }

    disable() {
        this._injectionManager?.clear()
        this._injectionManager = null
        if (this._addedMenuItems)
            this._removeMenuItems()
        this._addedMenuItems = null
        this._modifiedMenus = null
    }

    /**
     * Remove the Autostart menu items from the menus
     */
    _removeMenuItems() {
        for (let menu of this._modifiedMenus ?? [])
            delete menu._autostartEntryExtensionMenuItem

        for (let menuItem of this._addedMenuItems)
            menuItem.destroy()

        this._addedMenuItems.length = 0
    }
}

/**
 * @param {Gio.AppInfo} appInfo
 * @returns {string|null}
 */
function desktopId(appInfo) {
    try {
        return appInfo.get_id()
    } catch (e) {
        return null
    }
}

/**
 * Desktop ids are used as filenames in the autostart directory.
 * @param {string|null} appId
 * @returns {boolean}
 */
function isSafeDesktopId(appId) {
    return typeof appId === 'string' &&
        appId.endsWith('.desktop') &&
        appId.length > '.desktop'.length &&
        !appId.startsWith('.') &&
        !appId.includes('/') &&
        !appId.includes('\\') &&
        !appId.includes('\0')
}

/**
 * @param {Gio.AppInfo} appInfo
 * @returns {boolean}
 */
function isAutostartEnabled(appInfo) {
    try {
        let appId = desktopId(appInfo)
        if (!isSafeDesktopId(appId))
            return false

        let appExec = appExecKey(appInfo)
        let userEntries = matchingUserEntries(userAutostartDir(), appId, appExec)
        let userIdEntry = userEntries.find(entry => entry.name === appId)

        if (userIdEntry) {
            if (entryIsEnabled(userIdEntry.keyFile))
                return true
        } else {
            let systemKeyFile = loadSystemEntry(appId)
            if (systemKeyFile && entryIsEnabled(systemKeyFile))
                return true
        }

        return userEntries.some(entry => entry.name !== appId && entryIsEnabled(entry.keyFile))
    } catch (e) {
        return false
    }
}

/**
 * @param {string} extensionName
 * @param {Gio.AppInfo} appInfo
 * @param {boolean} enabled
 * @returns {boolean} False when the autostart files could not be updated
 */
function setAutostartEnabled(extensionName, appInfo, enabled) {
    try {
        let appId = desktopId(appInfo)
        if (!isSafeDesktopId(appId)) {
            console.warn(`${extensionName}: Refusing to change autostart for an unsafe desktop id`)
            return false
        }

        let userDir = userAutostartDir()
        if (!ensureDirectory(extensionName, userDir))
            return false

        if (enabled)
            return enableAutostart(extensionName, appInfo, appId, userDir)

        return disableAutostart(extensionName, appInfo, appId, userDir)
    } catch (e) {
        console.warn(`${extensionName}: ${e.message}`)
        return false
    }
}

/**
 * @param {string} extensionName
 * @param {Gio.AppInfo} appInfo
 * @param {string} appId
 * @param {string} userDir
 * @returns {boolean}
 */
function enableAutostart(extensionName, appInfo, appId, userDir) {
    let appExec = appExecKey(appInfo)
    let userEntries = matchingUserEntries(userDir, appId, appExec)

    if (userEntries.length > 0) {
        for (let entry of userEntries) {
            setAutostartFlags(entry.keyFile, true)
            if (!saveEntry(extensionName, entry.keyFile, entry.path))
                return false
        }
        return true
    }

    let systemPath = findSystemAutostartPath(appId)
    if (systemPath) {
        let keyFile = loadKeyFile(systemPath)
        if (!keyFile) {
            console.warn(`${extensionName}: Could not read ${systemPath}`)
            return false
        }
        setAutostartFlags(keyFile, true)
        return saveEntry(extensionName, keyFile, GLib.build_filenamev([userDir, appId]))
    }

    let filename = appDesktopFilename(appInfo)
    if (!filename) {
        console.warn(`${extensionName}: ${appId} has no desktop file`)
        return false
    }

    let source = loadKeyFile(filename)
    if (!source) {
        console.warn(`${extensionName}: Could not read ${filename}`)
        return false
    }

    let keyFile = desktopFileForAutostart(source, appDisplayName(appInfo))
    if (!keyFile) {
        console.warn(`${extensionName}: ${appId} has no command to autostart`)
        return false
    }

    return saveEntry(extensionName, keyFile, GLib.build_filenamev([userDir, appId]))
}

/**
 * @param {string} extensionName
 * @param {Gio.AppInfo} appInfo
 * @param {string} appId
 * @param {string} userDir
 * @returns {boolean}
 */
function disableAutostart(extensionName, appInfo, appId, userDir) {
    let appExec = appExecKey(appInfo)
    let userEntries = matchingUserEntries(userDir, appId, appExec)
    let systemPath = findSystemAutostartPath(appId)

    if (systemPath) {
        let idEntry = userEntries.find(entry => entry.name === appId)
        let keyFile = idEntry ? idEntry.keyFile : loadKeyFile(systemPath)
        if (!keyFile) {
            console.warn(`${extensionName}: Could not read the autostart entry for ${appId}`)
            return false
        }

        setAutostartFlags(keyFile, false)
        if (!saveEntry(extensionName, keyFile, GLib.build_filenamev([userDir, appId])))
            return false
    }

    for (let entry of userEntries) {
        if (systemPath && entry.name === appId)
            continue
        if (!deleteUserEntry(extensionName, userDir, entry.path))
            return false
    }

    return true
}

/**
 * @param {GLib.KeyFile} source
 * @param {string|null} fallbackName
 * @returns {GLib.KeyFile|null}
 */
function desktopFileForAutostart(source, fallbackName) {
    let keyFile = new GLib.KeyFile()
    let keys
    try {
        keys = unwrapList(source.get_keys(DESKTOP_GROUP))
    } catch (e) {
        return null
    }

    for (let key of keys) {
        if (!isKeptKey(key))
            continue
        try {
            keyFile.set_value(DESKTOP_GROUP, key, source.get_value(DESKTOP_GROUP, key))
        } catch (e) {
            // Skip a key that cannot be copied and keep the rest of the entry.
        }
    }

    if (hasKey(keyFile, 'Exec')) {
        try {
            let exec = stripFieldCodes(keyFile.get_string(DESKTOP_GROUP, 'Exec'))
            if (exec.length > 0)
                keyFile.set_string(DESKTOP_GROUP, 'Exec', exec)
            else
                keyFile.remove_key(DESKTOP_GROUP, 'Exec')
        } catch (e) {
            // Keep the Exec value copied from the original desktop file.
        }
    }

    let hasExec = hasKey(keyFile, 'Exec')
    if (!hasExec && !getBoolean(keyFile, 'DBusActivatable', false))
        return null

    if (!hasKey(keyFile, 'Type'))
        keyFile.set_string(DESKTOP_GROUP, 'Type', 'Application')
    if (!hasKey(keyFile, 'Name') && fallbackName)
        keyFile.set_string(DESKTOP_GROUP, 'Name', fallbackName)

    setAutostartFlags(keyFile, true)
    keyFile.set_boolean(DESKTOP_GROUP, 'NoDisplay', false)
    return keyFile
}

/**
 * @param {GLib.KeyFile} keyFile
 * @param {boolean} enabled
 */
function setAutostartFlags(keyFile, enabled) {
    keyFile.set_boolean(DESKTOP_GROUP, 'Hidden', !enabled)
    keyFile.set_boolean(DESKTOP_GROUP, 'X-GNOME-Autostart-enabled', enabled)
}

/**
 * A user file overrides a system file of the same name. Hidden=true or
 * X-GNOME-Autostart-enabled=false turns the entry off. OnlyShowIn and
 * NotShowIn are compared with XDG_CURRENT_DESKTOP.
 * @param {GLib.KeyFile} keyFile
 * @returns {boolean}
 */
function entryIsEnabled(keyFile) {
    if (!entryAppliesToDesktop(keyFile))
        return false
    if (getBoolean(keyFile, 'Hidden', false))
        return false
    return getBoolean(keyFile, 'X-GNOME-Autostart-enabled', true)
}

/**
 * @param {GLib.KeyFile} keyFile
 * @returns {boolean}
 */
function entryAppliesToDesktop(keyFile) {
    let current = (GLib.getenv('XDG_CURRENT_DESKTOP') || '').split(':').filter(name => name.length > 0)
    let onlyShowIn = hasKey(keyFile, 'OnlyShowIn') ? getStringList(keyFile, 'OnlyShowIn') : null
    let notShowIn = hasKey(keyFile, 'NotShowIn') ? getStringList(keyFile, 'NotShowIn') : null

    if (onlyShowIn && onlyShowIn.length > 0 && !current.some(name => onlyShowIn.includes(name)))
        return false
    if (notShowIn && notShowIn.length > 0 && current.some(name => notShowIn.includes(name)))
        return false
    return true
}

/**
 * @param {string} userDir
 * @param {string} appId
 * @param {string|null} appExec
 * @returns {{name: string, path: string, keyFile: GLib.KeyFile}[]}
 */
function matchingUserEntries(userDir, appId, appExec) {
    let matches = []
    for (let file of listDesktopFiles(userDir)) {
        let keyFile = loadKeyFile(file.path)
        if (!keyFile)
            continue

        let idMatch = file.name === appId
        let execMatch = appExec !== null && normalizedExec(keyFile) === appExec
        if (!idMatch && !execMatch)
            continue

        matches.push({
            name: file.name,
            path: file.path,
            keyFile,
        })
    }
    return matches
}

/**
 * @param {string} appId
 * @returns {GLib.KeyFile|null}
 */
function loadSystemEntry(appId) {
    let path = findSystemAutostartPath(appId)
    if (!path)
        return null
    return loadKeyFile(path)
}

/**
 * @param {string} appId
 * @returns {string|null}
 */
function findSystemAutostartPath(appId) {
    for (let dir of systemAutostartDirs()) {
        let path = GLib.build_filenamev([dir, appId])
        if (GLib.file_test(path, GLib.FileTest.IS_REGULAR))
            return path
    }
    return null
}

/**
 * @returns {string}
 */
function userAutostartDir() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'autostart'])
}

/**
 * @returns {string[]}
 */
function systemAutostartDirs() {
    return unwrapList(GLib.get_system_config_dirs()).map(dir =>
        GLib.build_filenamev([dir, 'autostart']))
}

/**
 * @param {string} dirPath
 * @returns {{name: string, path: string}[]}
 */
function listDesktopFiles(dirPath) {
    let directory = Gio.File.new_for_path(dirPath)
    if (!directory.query_exists(null))
        return []

    let enumerator
    try {
        enumerator = directory.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null)
    } catch (e) {
        return []
    }

    let files = []
    try {
        let info
        while ((info = enumerator.next_file(null))) {
            let fileType = info.get_file_type()
            if (fileType !== Gio.FileType.REGULAR && fileType !== Gio.FileType.SYMBOLIC_LINK)
                continue

            let name = info.get_name()
            if (!isSafeDesktopId(name))
                continue

            files.push({
                name,
                path: GLib.build_filenamev([dirPath, name]),
            })
        }
    } finally {
        enumerator.close(null)
    }

    return files
}

/**
 * @param {Gio.AppInfo} appInfo
 * @returns {string|null}
 */
function appExecKey(appInfo) {
    let filename = appDesktopFilename(appInfo)
    if (filename) {
        let keyFile = loadKeyFile(filename)
        let exec = keyFile ? normalizedExec(keyFile) : null
        if (exec)
            return exec
    }

    try {
        let command = appInfo.get_commandline()
        if (!command)
            return null
        let exec = stripFieldCodes(command)
        return exec.length > 0 ? exec : null
    } catch (e) {
        return null
    }
}

/**
 * @param {Gio.AppInfo} appInfo
 * @returns {string|null}
 */
function appDesktopFilename(appInfo) {
    try {
        if (typeof appInfo.get_filename === 'function') {
            let filename = appInfo.get_filename()
            if (filename)
                return filename
        }
    } catch (e) {
        // Fall through to the filename property.
    }

    return appInfo.filename || null
}

/**
 * @param {Gio.AppInfo} appInfo
 * @returns {string|null}
 */
function appDisplayName(appInfo) {
    try {
        return appInfo.get_name()
    } catch (e) {
        return null
    }
}

/**
 * @param {GLib.KeyFile} keyFile
 * @returns {string|null}
 */
function normalizedExec(keyFile) {
    if (!hasKey(keyFile, 'Exec'))
        return null

    try {
        let exec = stripFieldCodes(keyFile.get_string(DESKTOP_GROUP, 'Exec'))
        return exec.length > 0 ? exec : null
    } catch (e) {
        return null
    }
}

/**
 * Remove desktop entry field codes. "%%" becomes a literal "%".
 * @param {string} execLine
 * @returns {string}
 */
function stripFieldCodes(execLine) {
    let result = ''
    for (let i = 0; i < execLine.length; i++) {
        if (execLine[i] === '%' && i + 1 < execLine.length) {
            let code = execLine[i + 1]
            if (code === '%') {
                result += '%'
                i++
                continue
            }
            if (FIELD_CODES.includes(code)) {
                i++
                continue
            }
        }
        result += execLine[i]
    }

    return result.replace(/[ \t]{2,}/g, ' ').trim()
}

/**
 * @param {string} key
 * @returns {boolean}
 */
function isKeptKey(key) {
    if (KEPT_KEYS.includes(key))
        return true
    return /^(Name|Comment)\[[^[\]]+\]$/.test(key)
}

/**
 * @param {string} path
 * @returns {GLib.KeyFile|null}
 */
function loadKeyFile(path) {
    try {
        let keyFile = new GLib.KeyFile()
        let loaded = keyFile.load_from_file(path, GLib.KeyFileFlags.KEEP_TRANSLATIONS)
        if (loaded === false || !keyFile.has_group(DESKTOP_GROUP))
            return null
        return keyFile
    } catch (e) {
        return null
    }
}

/**
 * @param {string} extensionName
 * @param {GLib.KeyFile} keyFile
 * @param {string} path
 * @returns {boolean}
 */
function saveEntry(extensionName, keyFile, path) {
    if (!prepareDestination(extensionName, path))
        return false

    try {
        let saved = keyFile.save_to_file(path)
        if (saved === false) {
            console.warn(`${extensionName}: Failed to write ${path}`)
            return false
        }
        return true
    } catch (e) {
        console.warn(`${extensionName}: Failed to write ${path}: ${e.message}`)
        return false
    }
}

/**
 * save_to_file() follows symlinks. Replace a symlink with a regular file
 * so an autostart entry cannot write somewhere else.
 * @param {string} extensionName
 * @param {string} path
 * @returns {boolean}
 */
function prepareDestination(extensionName, path) {
    let file = Gio.File.new_for_path(path)
    try {
        let info = file.query_info(
            'standard::is-symlink',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null)
        if (!info.get_is_symlink())
            return true

        file.delete(null)
        return true
    } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return true
        console.warn(`${extensionName}: Failed to replace ${path}: ${e.message}`)
        return false
    }
}

/**
 * @param {string} extensionName
 * @param {string} userDir
 * @param {string} path
 * @returns {boolean}
 */
function deleteUserEntry(extensionName, userDir, path) {
    let prefix = userDir.endsWith('/') ? userDir : `${userDir}/`
    if (!path.startsWith(prefix)) {
        console.warn(`${extensionName}: Refusing to delete ${path}`)
        return false
    }

    try {
        Gio.File.new_for_path(path).delete(null)
        return true
    } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return true
        console.warn(`${extensionName}: Failed to delete ${path}: ${e.message}`)
        return false
    }
}

/**
 * @param {string} extensionName
 * @param {string} dirPath
 * @returns {boolean}
 */
function ensureDirectory(extensionName, dirPath) {
    let directory = Gio.File.new_for_path(dirPath)
    try {
        if (!directory.query_exists(null))
            directory.make_directory_with_parents(null)
        return true
    } catch (e) {
        console.warn(`${extensionName}: Failed to create ${dirPath}: ${e.message}`)
        return false
    }
}

/**
 * @param {GLib.KeyFile} keyFile
 * @param {string} key
 * @returns {boolean}
 */
function hasKey(keyFile, key) {
    try {
        return unwrapList(keyFile.get_keys(DESKTOP_GROUP)).includes(key)
    } catch (e) {
        return false
    }
}

/**
 * @param {GLib.KeyFile} keyFile
 * @param {string} key
 * @param {boolean} fallback
 * @returns {boolean}
 */
function getBoolean(keyFile, key, fallback) {
    if (!hasKey(keyFile, key))
        return fallback

    try {
        return keyFile.get_boolean(DESKTOP_GROUP, key)
    } catch (e) {
        return fallback
    }
}

/**
 * @param {GLib.KeyFile} keyFile
 * @param {string} key
 * @returns {string[]|null}
 */
function getStringList(keyFile, key) {
    try {
        return unwrapList(keyFile.get_string_list(DESKTOP_GROUP, key))
    } catch (e) {
        return null
    }
}

/**
 * GJS returns some GLib list calls as [values, length].
 * @param {any} value
 * @returns {any[]}
 */
function unwrapList(value) {
    if (Array.isArray(value) && value.length === 2 && Array.isArray(value[0]) && Number.isInteger(value[1]))
        return value[0]
    return value
}
