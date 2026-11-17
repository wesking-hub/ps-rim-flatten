@echo off
chcp 65001 >nul
title 文字边缘修复 (rim-flatten) 插件一键安装程序

echo ========================================================
echo   文字边缘修复 (rim-flatten) Photoshop 插件 - 一键安装
echo ========================================================
echo.

echo [1/2] 正在配置 Photoshop 扩展运行环境 (开启开发者模式)...
reg add "HKCU\Software\Adobe\CSXS.7" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul 2>&1
reg add "HKCU\Software\Adobe\CSXS.8" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul 2>&1
reg add "HKCU\Software\Adobe\CSXS.9" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul 2>&1
reg add "HKCU\Software\Adobe\CSXS.10" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul 2>&1
reg add "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul 2>&1
reg add "HKCU\Software\Adobe\CSXS.12" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul 2>&1
reg add "HKCU\Software\Adobe\CSXS.13" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul 2>&1
reg add "HKCU\Software\Adobe\CSXS.14" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul 2>&1
reg add "HKCU\Software\Adobe\CSXS.15" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul 2>&1
reg add "HKCU\Software\Adobe\CSXS.16" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul 2>&1
echo       已成功配置。

echo.
echo [2/2] 正在将插件安装至当前用户目录...
set "TARGET=%APPDATA%\Adobe\CEP\extensions\com.local.rimflatten.cep"

if not exist "%APPDATA%\Adobe\CEP\extensions" (
    mkdir "%APPDATA%\Adobe\CEP\extensions" >nul 2>&1
)

if exist "%TARGET%" (
    rd /s /q "%TARGET%" >nul 2>&1
)

xcopy "%~dp0com.local.rimflatten.cep\*" "%TARGET%\" /s /e /y /i /q >nul

if exist "%TARGET%\index.html" (
    echo       插件文件已成功部署至:
    echo       %TARGET%
) else (
    echo [错误] 复制失败，请右键选择「以管理员身份运行」重试。
    pause
    exit /b 1
)

echo.
echo ========================================================
echo   【安装成功！】
echo ========================================================
echo.
echo 使用说明：
echo   1. 如果 Photoshop 正在运行，请先完全退出后重新启动；
echo   2. 打开 PS 顶部菜单：【窗口】 - 【扩展功能(旧版)】 - 【文字边缘修复 rim-flatten】；
echo      （在 PS 2024~2026 中可能位于【窗口】 - 【扩展】或【增效工具】菜单下）
echo   3. 框选需要修复的文字及周围一圈背景，点击「开始处理选区」即可。
echo.
pause
