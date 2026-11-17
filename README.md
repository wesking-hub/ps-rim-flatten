# ps-rim-flatten · 文字边缘修复 v9

用于 Photoshop 的 CEP 面板插件，修复文字、图标周边的振铃波纹，并减轻彩色色块内部的明暗与色度凹凸。

## 安装

需要 Windows、支持 CEP 扩展的 Photoshop，以及 Python 3.11。

先安装 Python 依赖：

```powershell
py -3.11 -m pip install numpy opencv-python numba
```

1. 下载本仓库（Code → Download ZIP）并解压。
2. 完全退出 Photoshop。
3. 双击 [`chajian/一键安装.bat`](chajian/一键安装.bat)。
4. 重启 Photoshop，在「窗口 → 扩展功能（旧版）」打开「文字边缘修复 rim-flatten」。

安装器将扩展复制到当前用户的 `%APPDATA%\Adobe\CEP\extensions\com.local.rimflatten.cep`，并开启未签名 CEP 扩展所需的调试模式。无需单独复制核心脚本。

## 使用

框选需要修复的文字或色块，四周尽量留出约 30 像素背景，点击「开始处理选区」。默认生成带选区蒙版的独立「rim-flatten 修复层」，可开关图层对比。直接合并选项会改变当前图层，请按需使用。

仅支持 RGB 文档；选区导出为 8 位 PNG。首次处理包含 Numba 编译时间，耗时取决于选区大小与电脑性能。

## 仓库结构

```text
chajian/
├── com.local.rimflatten.cep/
│   ├── CSXS/manifest.xml
│   ├── index.html
│   ├── js/main.js
│   ├── jsx/bridge.jsx
│   ├── lib/CSInterface.js
│   └── tool/
│       ├── deringing_bridge.py
│       └── deringing_v9_ycrcb.py
├── 一键安装.bat
├── 一键卸载.bat
└── 使用说明.txt
requirements.txt
README.md
```

算法只保留一份，位于安装包的 `tool` 目录。命令行也可使用：

```powershell
py -3.11 -B chajian/com.local.rimflatten.cep/tool/deringing_v9_ycrcb.py 输入.png 输出.png
```

## 算法与限制

v9 直接从原图联合估计 Y、Cr、Cb，采用局部结构场、异方性采样和局部平面回归。不依赖旧版 v7/v8 的串接处理。

本项目在实际宣传单样本上经过视觉对比，仍有适用范围：低对比真实纹理可能被削弱，某些抗锯齿像素可能变化，不保证所有图片文字逐像素不变。建议先通过独立修复层检查效果。算法并不复现 Photoshop 黑白调整层。

## 卸载

退出 Photoshop，运行 [`chajian/一键卸载.bat`](chajian/一键卸载.bat)。

仓库只发布安装所需文件；实验图片、旧算法、缓存与调试产物不包含在发布历史中。
