# Claudio AI 电台 - 一键启动脚本
# 双击运行或在终端执行: .\start.ps1

Write-Host "`n  Claudio AI 情感电台" -ForegroundColor Magenta
Write-Host "  ====================" -ForegroundColor DarkGray
Write-Host ""

# 确认 .env 存在
if (-not (Test-Path ".env")) {
    Write-Host "  [!] 未找到 .env 文件，请先复制 .env.example 并填入配置" -ForegroundColor Red
    pause
    exit 1
}

Write-Host "  [+] 配置文件已就绪" -ForegroundColor Green

# 安装依赖（如需要）
if (-not (Test-Path "node_modules")) {
    Write-Host "  [+] 安装依赖中..." -ForegroundColor Yellow
    npm install
}

Write-Host "  [+] 启动后端 (http://localhost:3000) ..." -ForegroundColor Cyan
Write-Host "  [+] 启动前端 (http://localhost:5173) ..." -ForegroundColor Cyan
Write-Host ""
Write-Host "  按 Ctrl+C 停止所有服务" -ForegroundColor DarkGray
Write-Host ""

# 并行启动两个服务
concurrently -n BE,FE -c magenta,cyan "npm run dev:backend" "npm run dev:frontend"

pause
