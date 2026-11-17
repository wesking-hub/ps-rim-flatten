@echo off
chcp 65001 >nul
title 文字边缘修复 (rim-flatten) 插件一键卸载程序

echo ========================================================
echo   文字边缘修复 (rim-flatten) Photoshop 插件 - 一键卸载
echo ========================================================
echo.

set "TARGET=%APPDATA%\Adobe\CEP\extensions\com.local.rimflatten.cep"

if exist "%TARGET%" (
    rd /s /q "%TARGET%" >nul 2>&1
    echo 已成功删除插件目录: %TARGET%
    echo 卸载完成。重启 Photoshop 后该插件将不再显示。
) else (
    echo 未检测到已安装的插件目录。
)

echo.
pause
