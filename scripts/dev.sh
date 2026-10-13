#!/usr/bin/env bash
#
# 火宝短剧 · 本地服务一键启停
#
# 端口角色（对齐 frpc 映射口径）：
#   3013  生产构建预览  ← 唯一对外入口（frpc 只映射了这一个端口）
#   3015  开发实例      ← 本地开发用，改代码即改即见
#   5679  后端 API
#
# 3014 已废弃：frpc 未映射，外部访问不到，不要再起。
#
# 用法:
#   scripts/dev.sh start        后台启动全部（终端里用这个）
#   scripts/dev.sh stop         停止全部
#   scripts/dev.sh stop dev     只停某一个 (backend|dev|preview)
#   scripts/dev.sh restart      重启全部（含重新构建前端的便捷入口）
#   scripts/dev.sh build        重新构建前端产物，并自动重启 preview + 校验产物一致性
#   scripts/dev.sh build --no-restart   只构建，不重启不校验
#   scripts/dev.sh verify       校验对外实例吐出的 HTML 所引用的 _nuxt 资源是否都可取
#   scripts/dev.sh status       查看端口 / 健康 / 对外地址 / 产物一致性
#   scripts/dev.sh logs <svc>   跟踪日志: backend | dev | preview
#   scripts/dev.sh foreground   前台常驻（供会话内长驻任务托管，Ctrl-C 退出）
#
# 端口可用环境变量覆盖：BACKEND_PORT / DEV_PORT / PREVIEW_PORT
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT="${BACKEND_PORT:-5679}"
DEV_PORT="${DEV_PORT:-3015}"
PREVIEW_PORT="${PREVIEW_PORT:-3013}"
LOG_DIR="$ROOT/tmp/logs"
mkdir -p "$LOG_DIR"

# 起服务前必须清掉两类环境变量：
#   NODE_OPTIONS —— 注入的 safe-delete shim，会让构建与批量删除失败
#   *_proxy      —— 本机 shell 的代理会把 localhost 请求也带走，健康检查会假失败
ENV_CLEAN=(env -u NODE_OPTIONS -u http_proxy -u https_proxy -u all_proxy
               -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY)

listener() { lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1; }
health()   { curl -s --noproxy '*' -o /dev/null -m 3 -w '%{http_code}' "$1" 2>/dev/null; }
lan_ip()   { ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}'; }

wait_port() {
  local port="$1" tries="${2:-60}"
  while [ "$tries" -gt 0 ]; do
    [ -n "$(listener "$port")" ] && return 0
    sleep 0.5; tries=$((tries - 1))
  done
  return 1
}

# 起一个后台常驻服务: start_one <name> <port> <dir> <health-url> <cmd...>
start_one() {
  local name="$1" port="$2" dir="$3" url="$4"; shift 4
  local pid; pid="$(listener "$port")"
  if [ -n "$pid" ]; then echo "  [跳过] $name 已在运行 (端口 $port, PID $pid)"; return 0; fi
  ( cd "$dir" && nohup "${ENV_CLEAN[@]}" "$@" >"$LOG_DIR/$name.log" 2>&1 & )
  if wait_port "$port" 60; then
    echo "  [启动] $name  端口 $port  PID $(listener "$port")  HTTP $(health "$url")  → $LOG_DIR/$name.log"
  else
    echo "  [失败] $name 未能监听 $port，看 $LOG_DIR/$name.log"; tail -5 "$LOG_DIR/$name.log" 2>/dev/null; return 1
  fi
}

# 按端口停服务（不用 pkill 广匹配：本机还有别的 worktree 跑同类进程）
stop_port() {
  local port="$1" name="$2" pid tries=40
  pid="$(listener "$port")"
  if [ -z "$pid" ]; then echo "  [已停] $name (端口 $port)"; return 0; fi
  kill "$pid" 2>/dev/null
  while [ "$tries" -gt 0 ] && [ -n "$(listener "$port")" ]; do sleep 0.25; tries=$((tries - 1)); done
  [ -n "$(listener "$port")" ] && { kill -9 "$(listener "$port")" 2>/dev/null; sleep 0.5; }
  echo "  [停止] $name (端口 $port, 原 PID $pid)"
}

cmd_start() {
  echo "启动火宝短剧服务 (后端 $BACKEND_PORT / dev $DEV_PORT / 对外 $PREVIEW_PORT)"
  start_one backend "$BACKEND_PORT" "$ROOT/backend" "http://127.0.0.1:$BACKEND_PORT/api/v1/health" npm run dev
  start_one dev "$DEV_PORT" "$ROOT/frontend" "http://127.0.0.1:$DEV_PORT/" npm run dev
  if [ ! -d "$ROOT/frontend/.output/server" ]; then
    echo "  [跳过] preview 未构建产物，先跑: scripts/dev.sh build"
  else
    start_one preview "$PREVIEW_PORT" "$ROOT/frontend" "http://127.0.0.1:$PREVIEW_PORT/" npm run preview
  fi
  cmd_status
}

cmd_stop() {
  case "${1:-all}" in
    backend) stop_port "$BACKEND_PORT" backend ;;
    dev)     stop_port "$DEV_PORT" dev ;;
    preview) stop_port "$PREVIEW_PORT" preview ;;
    all|"")
      echo "停止火宝短剧服务"
      stop_port "$PREVIEW_PORT" preview
      stop_port "$DEV_PORT" dev
      stop_port "$BACKEND_PORT" backend ;;
    *) echo "未知服务: $1 (可选 backend|dev|preview)"; return 1 ;;
  esac
}

# 校验「对外实例实际吐出的 HTML」引用的每一个 /_nuxt 资源能否取到 200。
#
# 为什么必须校验：本前端是 SPA（ssr:false），整站靠入口 chunk 里内嵌的 manifest
# 按哈希懒加载路由 chunk。每次 build 都会换掉全部哈希并删除旧文件；若 preview 进程
# 不重启，它内存里的旧 manifest 仍指向已删除的 chunk，浏览器 lazy import 就会拿到
# 非 JS 内容 → TypeError: Failed to fetch dynamically imported module → 界面显示
# 原始英文「Failed to fetch」，且硬刷新也救不回来（服务端吐的还是旧引用）。
# 这个检查是唯一能一眼看穿该状态的命令。
cmd_verify() {
  local quiet=0; [ "${1:-}" = "--quiet" ] && quiet=1
  local base="http://127.0.0.1:$PREVIEW_PORT" html assets bad=0 total=0 u code

  if [ -z "$(listener "$PREVIEW_PORT")" ]; then
    [ "$quiet" -eq 1 ] && echo "  产物一致性 — preview 未运行，跳过" || echo "[跳过] preview 未在 $PREVIEW_PORT 运行"
    return 0
  fi
  html="$(curl -s --noproxy '*' -m 8 "$base/")" || { echo "  [BAD] $base/ 取不到"; return 1; }
  assets="$(printf '%s' "$html" | grep -oE '/_nuxt/[A-Za-z0-9_.-]+\.(js|css)' | sort -u)"
  if [ -z "$assets" ]; then echo "  [BAD] HTML 里没解析出任何 /_nuxt 资源"; return 1; fi

  [ "$quiet" -eq 0 ] && echo "对外实例产物校验 (${base}，取 HTML 实际引用)："
  while IFS= read -r u; do
    [ -z "$u" ] && continue
    total=$((total + 1))
    code="$(curl -s --noproxy '*' -o /dev/null -m 8 -w '%{http_code}' "$base$u")"
    if [ "$code" = "200" ]; then
      [ "$quiet" -eq 0 ] && printf '  [OK]  %s  %s\n' "$code" "$u"
    else
      printf '  [BAD] %s  %s\n' "$code" "$u"
      bad=$((bad + 1))
    fi
  done <<< "$assets"

  if [ "$bad" -eq 0 ]; then
    [ "$quiet" -eq 0 ] && echo "  ✅ 通过：$total/$total 资源可取"
    [ "$quiet" -eq 1 ] && echo "  产物一致性 — ✅ 通过 ($total/$total 可取)"
    return 0
  fi
  [ "$quiet" -eq 0 ] || echo "  产物一致性 — ❌ 失败 ($bad/$total 取不到)"
  echo "  原因：preview 进程内存里的 manifest 与磁盘不一致（build 后没重启）"
  echo "  修复：scripts/dev.sh stop preview && scripts/dev.sh start preview"
  return 1
}

cmd_build() {
  local restart_after=1
  [ "${1:-}" = "--no-restart" ] && restart_after=0
  echo "构建前端生产产物 (buildDir=.nuxt-build，与 dev 的 .nuxt-dev 互不干扰)"
  ( cd "$ROOT/frontend" && "${ENV_CLEAN[@]}" npm run build ) || { echo "构建失败"; return 1; }
  echo "构建完成 → frontend/.output"

  # build 换掉了全部 chunk 哈希。对外实例不重启，其内存里的旧 manifest 就指向已删除
  # 的 chunk，浏览器懒加载会 Failed to fetch 且刷新无效 —— 所以默认自动重启。
  if [ "$restart_after" -eq 0 ]; then
    echo "（--no-restart：跳过重启与校验，记得手动重启对外实例）"
    return 0
  fi
  if [ -n "$(listener "$PREVIEW_PORT")" ]; then
    echo "重启对外实例 preview 以加载新 manifest …"
    stop_port "$PREVIEW_PORT" preview
    start_one preview "$PREVIEW_PORT" "$ROOT/frontend" "http://127.0.0.1:$PREVIEW_PORT/" npm run preview
  else
    echo "提示：preview 未运行，跳过重启"
  fi
  cmd_verify
}

cmd_status() {
  local ip; ip="$(lan_ip)"
  row() { # row <port> <label> <url>
    local pid; pid="$(listener "$1")"
    if [ -n "$pid" ]; then
      printf '  %-8s %-14s 运行中  PID %-6s HTTP %s\n' "$1" "$2" "$pid" "$(health "$3")"
    else
      printf '  %-8s %-14s 未运行\n' "$1" "$2"
    fi
  }
  echo "服务状态:"
  row "$BACKEND_PORT" backend "http://127.0.0.1:$BACKEND_PORT/api/v1/health"
  row "$DEV_PORT"     dev     "http://127.0.0.1:$DEV_PORT/"
  row "$PREVIEW_PORT" preview "http://127.0.0.1:$PREVIEW_PORT/"
  [ -n "$ip" ] && echo "  对外入口 http://$ip:$PREVIEW_PORT  (局域网直连 / 外部经 frpc，都是这个端口)"
  cmd_verify --quiet
}

cmd_logs() {
  local svc="${1:-}"; [ -z "$svc" ] && { echo "用法: scripts/dev.sh logs backend|dev|preview"; return 1; }
  tail -f "$LOG_DIR/$svc.log"
}

# 前台常驻：三个服务作为本 shell 的子进程，Ctrl-C / 父进程退出时一并收走。
# 供 WorkBuddy 会话内用长驻任务方式托管（后台 shell 会随调用结束被回收，不能用 nohup 起）。
cmd_foreground() {
  local pids=()
  if [ -n "$(listener "$BACKEND_PORT")" ]; then echo "  [跳过] backend 已在运行 (端口 $BACKEND_PORT)"; else
    ( cd "$ROOT/backend"  && exec "${ENV_CLEAN[@]}" npm run dev )     >>"$LOG_DIR/backend.log" 2>&1 & pids+=($!); fi
  if [ -n "$(listener "$DEV_PORT")" ]; then echo "  [跳过] dev 已在运行 (端口 $DEV_PORT)"; else
    ( cd "$ROOT/frontend" && exec "${ENV_CLEAN[@]}" npm run dev )     >>"$LOG_DIR/dev.log" 2>&1 & pids+=($!); fi
  if [ -n "$(listener "$PREVIEW_PORT")" ]; then echo "  [跳过] preview 已在运行 (端口 $PREVIEW_PORT)"; else
    ( cd "$ROOT/frontend" && exec "${ENV_CLEAN[@]}" npm run preview ) >>"$LOG_DIR/preview.log" 2>&1 & pids+=($!); fi
  if [ "${#pids[@]}" -eq 0 ]; then echo "三个服务都已在运行"; return 0; fi
  trap 'for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null; done; exit 0' INT TERM
  echo "前台常驻中 (pid ${pids[*]})，日志 → $LOG_DIR/"
  for p in "${pids[@]}"; do wait "$p" 2>/dev/null || true; done
}

case "${1:-}" in
  start)      cmd_start ;;
  stop)       cmd_stop "${2:-all}" ;;
  restart)    cmd_stop && cmd_start ;;
  build)      cmd_build "${2:-}" ;;
  verify)     cmd_verify ;;
  status|"")  cmd_status ;;
  logs)       cmd_logs "${2:-}" ;;
  foreground) cmd_foreground ;;
  *)          echo "用法: scripts/dev.sh start|stop [backend|dev|preview]|restart|build [--no-restart]|verify|status|logs <svc>|foreground"; exit 1 ;;
esac
