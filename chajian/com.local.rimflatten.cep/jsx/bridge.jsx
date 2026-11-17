/**
 * rim-flatten CEP 扩展 —— PS 侧桥接（ExtendScript）
 *
 * 由面板通过 CSInterface.evalScript 调用。分三个原子操作：
 *   rfGetBounds()      读选区包围盒
 *   rfExport(path)     把选区导出成 PNG（并暂存用户选区）
 *   rfPlace(path, L,T) 把结果图放回文档（落在仅含修复内容的独立新图层上，并绑定选区蒙版，保持原选区不丢）
 */

var RF_TMP = Folder.temp.fsName.replace(/\\/g, '/');
var RF_SEL_CHANNEL = '__rf_saved_sel__';

function rfEsc(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
}

function rfPx(o) {
    if (!o) return 0;
    try {
        if (typeof o.as === 'function') return o.as('px');
        if (o.value !== undefined) return o.value;
    } catch (e) {}
    return Number(o) || 0;
}

function rfBounds() {
    var doc = app.activeDocument;
    var b = null;
    try { b = doc.selection.bounds; } catch (e) { b = null; }
    if (!b) return null;
    return {
        left: Math.max(0, Math.floor(rfPx(b[0]))),
        top: Math.max(0, Math.floor(rfPx(b[1]))),
        right: Math.min(Math.round(rfPx(doc.width)), Math.ceil(rfPx(b[2]))),
        bottom: Math.min(Math.round(rfPx(doc.height)), Math.ceil(rfPx(b[3])))
    };
}

/** 面板调用：返回 {"ok":true,"left":..,...} 或 {"ok":false,"error":".."} */
function rfGetBounds() {
    try {
        if (app.documents.length === 0) return '{"ok":false,"error":"没有打开的文档"}';
        var doc = app.activeDocument;
        if (doc.mode !== DocumentMode.RGB) {
            return '{"ok":false,"error":"只支持 RGB 文档，当前是 ' + rfEsc(doc.mode) + '"}';
        }
        var b = rfBounds();
        if (!b) return '{"ok":false,"error":"没有活动选区。请先框住文字和周围一圈背景。"}';
        var w = b.right - b.left, h = b.bottom - b.top;
        if (w < 8 || h < 8) {
            return '{"ok":false,"error":"选区太小：' + w + 'x' + h + '"}';
        }
        return '{"ok":true,"left":' + b.left + ',"top":' + b.top +
            ',"right":' + b.right + ',"bottom":' + b.bottom +
            ',"width":' + w + ',"height":' + h + '}';
    } catch (e) {
        return '{"ok":false,"error":"' + rfEsc(e.message) + ' @' + (e.line || '?') + '"}';
    }
}

/** 清理残留的历史暂存通道，避免通道面板冗余 */
function rfCleanSavedSelection(doc) {
    try {
        for (var i = doc.channels.length - 1; i >= 0; i--) {
            var ch = doc.channels[i];
            if (ch.name === RF_SEL_CHANNEL) {
                ch.remove();
            }
        }
    } catch (e) {}
}

/** 将当前用户的真实选区暂存到专属 Alpha 通道中 */
function rfSaveSelection(doc) {
    try {
        rfCleanSavedSelection(doc);
        var ch = doc.channels.add();
        ch.name = RF_SEL_CHANNEL;
        doc.selection.store(ch, SelectionType.REPLACE);
        doc.activeChannels = doc.componentChannels;
        return ch;
    } catch (e) {
        return null;
    }
}

/** 获取已暂存的选区通道 */
function rfGetSavedSelection(doc) {
    try {
        for (var i = 0; i < doc.channels.length; i++) {
            if (doc.channels[i].name === RF_SEL_CHANNEL) {
                return doc.channels[i];
            }
        }
    } catch (e) {}
    return null;
}

/** 将当前选区转为活动图层的图层蒙版（显示选区） */
function rfMakeMaskFromSelection() {
    try {
        var desc = new ActionDescriptor();
        desc.putClass(charIDToTypeID("Nw  "), charIDToTypeID("Chnl"));
        var ref = new ActionReference();
        ref.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), charIDToTypeID("Msk "));
        desc.putReference(charIDToTypeID("At  "), ref);
        desc.putEnumerated(charIDToTypeID("Usng"), charIDToTypeID("UsrM"), charIDToTypeID("RvlS"));
        executeAction(charIDToTypeID("Mk  "), desc, DialogModes.NO);
        return true;
    } catch (e) {
        return false;
    }
}

/** 递归按 id 找图层（支持任意层级嵌套的图层组） */
function rfLayerById(container, id) {
    if (!container || !container.layers) return null;
    for (var i = 0; i < container.layers.length; i++) {
        var l = container.layers[i];
        if (l.id === id) return l;
        if (l.typename === 'LayerSet') {
            var found = rfLayerById(l, id);
            if (found) return found;
        }
    }
    return null;
}

/**
 * 面板调用：把当前选区导出成 PNG。
 * 同时暂存用户的真实选区到通道中，确保后续不会丢失。
 */
function rfExport(outPath) {
    var origUnits = app.preferences.rulerUnits;
    try {
        app.preferences.rulerUnits = Units.PIXELS;
        var doc = app.activeDocument;
        var b = rfBounds();
        if (!b) return '{"ok":false,"error":"没有活动选区"}';

        // 暂存用户选区
        rfSaveSelection(doc);

        var out = new File(outPath);
        if (out.exists) out.remove();

        var dup = doc.duplicate('rf-export-tmp', false);
        try {
            dup.selection.select([[b.left, b.top], [b.right, b.top],
                [b.right, b.bottom], [b.left, b.bottom]], SelectionType.REPLACE);
            dup.crop([b.left, b.top, b.right, b.bottom]);
            if (dup.bitsPerChannel !== BitsPerChannelType.EIGHT) {
                dup.bitsPerChannel = BitsPerChannelType.EIGHT;
            }
            dup.saveAs(new File(outPath), new PNGSaveOptions(), true, Extension.LOWERCASE);
        } finally {
            try { dup.close(SaveOptions.DONOTSAVECHANGES); } catch (e1) {}
        }
        var chk = new File(outPath);
        if (!chk.exists) return '{"ok":false,"error":"导出失败，文件未生成"}';
        return '{"ok":true,"path":"' + rfEsc(outPath) + '","bytes":' + chk.length +
            ',"width":' + (b.right - b.left) + ',"height":' + (b.bottom - b.top) + '}';
    } catch (e) {
        return '{"ok":false,"error":"' + rfEsc(e.message) + ' @' + (e.line || '?') + '"}';
    } finally {
        try { app.preferences.rulerUnits = origUnits; } catch (e2) {}
    }
}

/**
 * 面板调用：把处理好的图放回文档。
 *
 * direct = false（默认）：
 *   - 绝不冗余复制整张底图
 *   - 仅粘贴修复选区范围的内容（外围全透明）
 *   - 绑定原选区的图层蒙版（仅选区内生效，不规则选区完美边缘过渡）
 *   - 选区信息完好恢复保留（蚂蚁线不丢）
 *
 * direct = true：
 *   - 仅将选区蒙版范围内的修复像素合并入当前图层
 *   - 选区信息完好恢复保留
 */
function rfPlace(path, L, T, R, B, direct) {
    var origUnits = app.preferences.rulerUnits;
    var doc = app.activeDocument;
    var src = null;
    try {
        app.preferences.rulerUnits = Units.PIXELS;
        var origTarget = doc.activeLayer;
        var origTargetId = origTarget.id;

        // 确保选区已被暂存
        var savedCh = rfGetSavedSelection(doc);
        if (!savedCh) {
            savedCh = rfSaveSelection(doc);
        }

        src = app.open(new File(path));
        var mw = Math.round(rfPx(src.width)), mh = Math.round(rfPx(src.height));
        if (mw !== (R - L) || mh !== (B - T)) {
            throw new Error('结果图 ' + mw + 'x' + mh + ' 与导出区域 ' + (R - L) + 'x' + (B - T) + ' 不一致');
        }

        // 复制结果图并立即关闭源文件
        src.selection.selectAll();
        src.selection.copy();
        src.close(SaveOptions.DONOTSAVECHANGES);
        src = null;

        app.activeDocument = doc;
        var target = rfLayerById(doc, origTargetId);
        if (!target) throw new Error('粘贴前目标图层丢失 id=' + origTargetId);
        doc.activeLayer = target;

        // 设置矩形选区以精准对齐粘贴位置 [L, T, R, B]
        doc.selection.select([[L, T], [R, T], [R, B], [L, B]], SelectionType.REPLACE);

        // 粘贴生成仅含修复矩形（外围透明）的新图层
        doc.paste();
        var pastedLayer = doc.activeLayer;
        if (!pastedLayer || pastedLayer.id === target.id) {
            throw new Error('粘贴没有生成新图层');
        }

        if (!direct) {
            // 模式 1：独立图层（仅选区修复内容 + 选区图层蒙版）
            try { pastedLayer.name = 'rim-flatten 修复层'; } catch (e0) {}

            if (savedCh) {
                doc.selection.load(savedCh, SelectionType.REPLACE);
                rfMakeMaskFromSelection();
            }

            doc.activeChannels = doc.componentChannels;

            // 再次加载选区，让用户的蚂蚁线依然保持在屏幕上
            if (savedCh) {
                doc.selection.load(savedCh, SelectionType.REPLACE);
                try { savedCh.remove(); } catch (e1) {}
            }

            return '{"ok":true,"direct":false,"layer":"' + rfEsc(pastedLayer.name) + '"}';
        } else {
            // 模式 2：直接合并入当前图层
            if (savedCh) {
                doc.selection.load(savedCh, SelectionType.REPLACE);
                rfMakeMaskFromSelection();
            }

            pastedLayer.merge();

            var got = rfLayerById(doc, origTargetId);
            if (!got) throw new Error('合并后目标图层丢失 id=' + origTargetId);
            doc.activeLayer = got;

            doc.activeChannels = doc.componentChannels;

            // 恢复选区
            if (savedCh) {
                doc.selection.load(savedCh, SelectionType.REPLACE);
                try { savedCh.remove(); } catch (e2) {}
            }

            return '{"ok":true,"direct":true,"layer":"' + rfEsc(got.name) + '"}';
        }
    } catch (e) {
        return '{"ok":false,"error":"' + rfEsc(e.message) + ' @' + (e.line || '?') + '"}';
    } finally {
        try { if (src) src.close(SaveOptions.DONOTSAVECHANGES); } catch (e3) {}
        try {
            var chk = rfGetSavedSelection(doc);
            if (chk) chk.remove();
        } catch (e4) {}
        try { app.preferences.rulerUnits = origUnits; } catch (e5) {}
    }
}

function rfTempDir() {
    return RF_TMP;
}
