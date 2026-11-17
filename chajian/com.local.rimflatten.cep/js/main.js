/*
 * rim-flatten CEP 面板逻辑
 *
 * 为什么是 CEP：面板是带 Node.js 的 Chromium，所以能同时
 *   1) 用 child_process 调本地算法工具（快 —— 比 ExtendScript 快约 470 倍）
 *   2) 用 CSInterface.evalScript 直接操作 PS 文档（不用手动拖文件）
 * ExtendScript 干不了第 1 件，UXP 干得了第 1 件但要 Developer Tool 才能载入。
 *
 * 关键坑（实测）：ExtendScript 的函数定义**活不过一次 evalScript 调用**。
 * 内联 eval 与 $.evalFile 当次都返回成功，下一次调用就报 "rfGetBounds 不是函数"。
 * 因此这里每次调用都把「桥接源码 + 调用表达式」拼进同一个 evalScript 执行。
 */
/* global CSInterface, SystemPath, window, require */

(function () {
  'use strict'

  var cs = new CSInterface()
  var els = {
    direct: document.getElementById('direct'),
    run: document.getElementById('run'),
    log: document.getElementById('log'),
  }

  // ---- Node 能力（CEP 注入）----
  function req(name) {
    if (typeof window.cep_node !== 'undefined' && window.cep_node.require) return window.cep_node.require(name)
    if (typeof require === 'function') return require(name)
    throw new Error('拿不到 Node 的 require（CEFCommandLine 里的 --enable-nodejs 没生效？）')
  }

  var fs = null, cp = null, osMod = null
  try {
    fs = req('fs')
    cp = req('child_process')
    osMod = req('os')
  } catch (e) {
    document.getElementById('log').innerHTML = '<span class="err">初始化 Node 失败：' + e.message + '</span>'
  }

  function setLog(html) { els.log.innerHTML = html }
  function writeLog(text, cls) { setLog((cls ? '<span class="' + cls + '">' : '<span>') + esc(text) + '</span>') }
  function appendLog(text, cls) {
    els.log.innerHTML += '\n' + (cls ? '<span class="' + cls + '">' : '<span>') + esc(text) + '</span>'
    els.log.scrollTop = els.log.scrollHeight
    // 日志太长会拖慢面板，留最近 200 行就够
    if (els.log.innerHTML.length > 40000) {
      var lines = els.log.innerHTML.split('\n')
      if (lines.length > 200) els.log.innerHTML = lines.slice(lines.length - 200).join('\n')
    }
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;') }

  // ---- 任何异常都要显示在面板里，不能让它悄悄把面板弄死 ----
  window.onerror = function (msg, src, line, col) {
    try { appendLog('面板脚本错误：' + msg + ' @' + line + ':' + col, 'err') } catch (e) {}
    return false
  }
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason
    try { appendLog('未处理的异常：' + ((r && r.message) ? r.message : String(r)), 'err') } catch (e) {}
  })
  try {
    if (typeof process !== 'undefined' && process.on) {
      process.on('uncaughtException', function (e) {
        try { appendLog('Node 未捕获异常：' + (e && e.message ? e.message : e), 'err') } catch (e2) {}
      })
    }
  } catch (e) { /* mixed-context 下拿不到 process 就算了 */ }

  // ---- 参数 ----（v6 全自动，无算法参数；仅贴回方式可选）
  function opts() {
    return {
      direct: els.direct.checked,
    }
  }

  function evalScript(script) {
    return new Promise(function (resolve) { cs.evalScript(script, function (r) { resolve(r) }) })
  }

  function parseJson(s) {
    if (s === 'EvalScript error.' || s === undefined || s === null) {
      throw new Error('ExtendScript 调用失败（CEP 固定返回 EvalScript error.）')
    }
    var text = String(s).replace(/^\uFEFF/, '').trim()
    try { return JSON.parse(text) } catch (e) {
      throw new Error('ExtendScript 返回的不是 JSON：『' + text.slice(0, 200) + '』')
    }
  }

  function q(s) { return String(s).replace(/\\/g, '/').replace(/'/g, "\\'") }

  // ---- 桥接：每次调用动态读取源码（免重启/免重载即时生效）----
  function bridgeSource() {
    var extDir = cs.getSystemPath(SystemPath.EXTENSION).replace(/\\/g, '/')
    var p = extDir + '/jsx/bridge.jsx'
    var raw = fs.readFileSync(p, 'utf8')
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')      // 块注释
      .replace(/^[ \t]*\/\/.*$/gm, ' ')       // 整行注释
      .replace(/[ \t]+\/\/[^\r\n]*/g, ' ')    // 行尾注释
      // 行尾注释这条不能省：源码折成一行后，一个 // 会把后面全部注释掉，
      // 结果是 evalScript 直接返回 "EvalScript error."，且没有任何线索。
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
  }

  /** 在一次 evalScript 里"先定义后调用"；call 是调用表达式，如 "rfGetBounds()" */
  function callBridge(call) {
    var src
    try { src = bridgeSource() } catch (e) {
      return Promise.resolve('{"ok":false,"error":"读取桥接文件失败：' + e.message + '"}')
    }
    var script =
      "(function(){" +
      "  try {" +
      "    eval(" + JSON.stringify(src) + ");" +
      "    return String(" + call + ");" +
      "  } catch (e) {" +
      "    return '{\"ok\":false,\"error\":\"bridge: ' + " +
      "      String(e.message).replace(/\\\\/g,'/').replace(/\"/g,\"'\").replace(/\\r?\\n/g,' ') + " +
      "      ' @' + (e.line||'?') + '\"}';" +
      "  }" +
      "})()"
    return evalScript(script)
  }

  // ---- 主流程 ----
  var running = false
  function run() {
    if (!fs) { writeLog('Node 不可用，无法处理。', 'err'); return }
    if (running) { appendLog('上一次还在处理，先等它结束。', 'warn'); return }
    running = true
    els.run.disabled = true
    setLog('处理中（v9 联合通道引擎运行中）…')

    var extDir = cs.getSystemPath(SystemPath.EXTENSION).replace(/\\/g, '/')
    var toolPath = extDir + '/tool/deringing_bridge.py'
    var tmpDir
    try {
      tmpDir = osMod.tmpdir().replace(/\\/g, '/').replace(/\/+$/, '')
    } catch (e) {
      writeLog('取临时目录失败：' + e.message, 'err')
      running = false
      els.run.disabled = false
      return
    }

    var t0 = Date.now()
    var o = opts()
    var info = null

    evalScript('app.name + " " + app.version')
      .then(function (probe) {
        if (probe === 'EvalScript error.') throw new Error('evalScript 通道不通，PS 侧没有响应')
        return callBridge('rfGetBounds()')
      })
      .then(function (raw) {
        var r = parseJson(raw)
        if (!r.ok) throw new Error(r.error)
        info = r
        var selPng = tmpDir + '/rf_cep_sel.png'
        info.selPng = selPng
        return callBridge("rfExport('" + q(selPng) + "')")
      })
      .then(function (raw) {
        var r = parseJson(raw)
        if (!r.ok) throw new Error(r.error)
        return processWithPython(toolPath, r.path, o)
      })
      .then(function (j) {
        var pol = j.inkIsDark ? '白底黑字/浅色底' : '黑板/深色底'
        appendLog('✓ 选区与模式：' + j.size + '（' + pol + '）')
        if (j.warnings && j.warnings.length) j.warnings.forEach(function (w) { appendLog('提示：' + w, 'warn') })
        if (!j.processed) throw new Error('该选区暂不适合处理（背景起伏过大或边缘留白过窄）。建议稍扩大选区再试。')
        appendLog('✓ [v9] 修复完成：改动 ' + j.changedPct + '% 像素，最大Δ ' + j.maxDelta + ' 灰阶（算法耗时 ' + j.ms + ' ms）', 'ok')
        return callBridge("rfPlace('" + q(j.output) + "'," +
          info.left + ',' + info.top + ',' + info.right + ',' + info.bottom + ',' +
          (o.direct ? 'true' : 'false') + ')')
      })
      .then(function (raw) {
        var r = parseJson(raw)
        if (!r.ok) throw new Error(r.error)
        if (r.direct) appendLog('✓ 处理完毕（总耗时 ' + (Date.now() - t0) + ' ms）：已合并入「' + r.layer + '」，选区已保留。', 'ok')
        else appendLog('✓ 处理完毕（总耗时 ' + (Date.now() - t0) + ' ms）：已生成「' + r.layer + '」（含选区蒙版，选区已保留）。', 'ok')
      })
      .catch(function (err) {
        appendLog('失败：' + err.message, 'err')
      })
      .then(function () { running = false; els.run.disabled = false })
  }

  /*
   * 剖面按"离字边多少像素"分桶，bin i = 距离 [i, i+1)。
   * 纸面像素到墨的最小距离就是 1，所以 bin1 才是紧贴字边的那一圈 —— 亮边就在这里。
   * 取 1/2/3/4/8/16 六个点，看得出"先变亮再变暗"有没有被拉平。
   */
  function shortProfile(arr) {
    if (!arr) return '(无)'
    var idx = [1, 2, 3, 4, 8, 16], out = []
    for (var k = 0; k < idx.length; k++) {
      var v = arr[idx[k]]
      out.push(v === undefined || v === null ? '?' : Math.round(v))
    }
    return out.join(' ')
  }

  /** 调算法工具：优先通过 node 异步子进程，若系统无 node 则无缝降级为 CEP 内置执行 */
  function processWithPython(toolPath, inPng, o) {
    return new Promise(function (resolve, reject) {
      if (!fs.existsSync(toolPath)) { reject(new Error('找不到算法工具：' + toolPath)); return }
      var outPng = inPng.replace(/\.png$/i, '') + '_fixed.png'
      var statusPath = inPng.replace(/\.png$/i, '') + '_status.json'
      try { if (fs.existsSync(statusPath)) fs.unlinkSync(statusPath) } catch (e) { /* ignore */ }

      // v9 全自动：旧版 far/keep/ramp/strength/negate 参数桥接接受但忽略
      var baseArgs = [toolPath, inPng, outPng, '--quiet', '--status=' + statusPath]
      var launchers = [['py', ['-3.11'].concat(baseArgs)], ['python', baseArgs], ['python3', baseArgs]]

      function tryLauncher(i) {
        if (i >= launchers.length) {
          reject(new Error('未找到 Python（依次试过 py -3.11 / python / python3）。v9 需要 Python + opencv-python、numpy、scipy、numba。'))
          return
        }
        try {
          cp.execFile(launchers[i][0], launchers[i][1], {
            windowsHide: true,
            timeout: 600000,
            maxBuffer: 8 * 1024 * 1024,
          }, function (err, stdout, stderr) {
            if (!err && fs.existsSync(statusPath)) {
              try {
                var j = JSON.parse(fs.readFileSync(statusPath, 'utf8'))
                j.output = outPng
                resolve(j)
                return
              } catch (e) { /* fallback */ }
            }
            if (err && (err.code === 'ENOENT' || String(err.message).indexOf('ENOENT') >= 0)) {
              tryLauncher(i + 1)
              return
            }
            var detail = stderr ? String(stderr).slice(0, 300) : (err ? String(err.message) : '')
            reject(new Error('工具没产出结果。' + detail))
          })
        } catch (spawnErr) {
          tryLauncher(i + 1)
        }
      }
      tryLauncher(0)
    })
  }

  // ---- 绑定与启动 ----
  els.run.addEventListener('click', run)

  // 启动自检：确认通道可用 + 桥接能在一次调用里跑通
  if (fs) {
    evalScript('app.name + " " + app.version').then(function (probe) {
      if (probe === 'EvalScript error.') {
        appendLog('evalScript 通道不通。请把 帮助→增效工具/插件日志 的内容发我。', 'err')
        return
      }
      appendLog('已连接 ' + probe)
      return callBridge('rfTempDir()').then(function (tmp) {
        if (tmp && tmp !== 'EvalScript error.' && tmp.indexOf('{') !== 0) {
          appendLog('桥接就绪。框好选区后点上面的按钮。', 'ok')
        } else {
          appendLog('桥接自检返回异常：' + tmp, 'err')
        }
      })
    })
  }
})()
