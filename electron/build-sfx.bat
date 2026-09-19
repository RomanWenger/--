@echo off
REM 7z 自解压安装包构建脚本
REM 需要安装 7-Zip (https://www.7-zip.org)

set SEVEN_ZIP="C:\Program Files\7-Zip\7z.exe"
set SOURCE="..\release-final\win-unpacked"
set OUTPUT="..\release-final\吉隆口岸泥石流救援仿真系统-Setup-1.0.0.exe"
set CONFIG_FILE=".\sfx-config.txt"

REM 创建自解压配置
echo ;!@Install@!UTF-8! > %CONFIG_FILE%
echo Title="吉隆口岸泥石流救援仿真系统 安装程序" >> %CONFIG_FILE%
echo BeginPrompt="是否安装吉隆口岸泥石流救援仿真系统？" >> %CONFIG_FILE%
echo RunProgram="吉隆口岸泥石流救援仿真系统.exe" >> %CONFIG_FILE%
echo ;!@InstallEnd@! >> %CONFIG_FILE%

REM 构建 SFX
%SEVEN_ZIP% a -sfx7zSFX %OUTPUT% %SOURCE%\* -mx=1

del %CONFIG_FILE%
echo 完成: %OUTPUT%
