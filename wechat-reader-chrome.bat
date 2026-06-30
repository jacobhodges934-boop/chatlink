@echo off
:: 启动 Chrome 供 wechat-reader attach 模式使用
:: 使用独立 profile，不影响日常 Chrome 数据
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\.wechat-reader\profiles\default"
echo Chrome started with remote debugging on port 9222
echo Profile: %USERPROFILE%\.wechat-reader\profiles\default
echo.
echo 1. 在此 Chrome 中登录微信公众平台 https://mp.weixin.qq.com
echo 2. 然后 agent 就可以通过 wechat-reader MCP 读文章了
pause
