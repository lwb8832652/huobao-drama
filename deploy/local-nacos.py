#!/usr/bin/env python3
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "tmp" / "local-nacos"
STATE = RUNTIME / "session.json"
REGISTER = ROOT / "deploy" / "nacos-register.sh"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def fetch(url, headers=None):
    try:
        with OPENER.open(urllib.request.Request(url, headers=headers or {}), timeout=8) as response:
            return response.status, response.read(8 << 20), dict(response.headers)
    except urllib.error.HTTPError as error:
        return error.code, error.read(8 << 20), dict(error.headers)


def wait_for(label, check, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if check():
                return
        except (OSError, ValueError, urllib.error.URLError):
            pass
        time.sleep(0.4)
    raise RuntimeError(label + " 超时")


def identity(pid):
    result = subprocess.run(["ps", "-p", str(pid), "-o", "lstart=", "-o", "stat="], capture_output=True, text=True)
    fields = result.stdout.strip().split()
    return " ".join(fields[:-1]) if result.returncode == 0 and fields and not fields[-1].startswith("Z") else ""


def alive(process):
    return bool(process and identity(process["pid"]) == process["started"])


def spawn(command, name, env):
    with (RUNTIME / (name + ".log")).open("a") as log:
        child = subprocess.Popen(command, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    started = identity(child.pid)
    if not started:
        raise RuntimeError(name + " 启动失败，请检查日志")
    return {"pid": child.pid, "started": started}


def stop(process):
    if alive(process):
        os.kill(process["pid"], signal.SIGTERM)
        wait_for("进程退出", lambda: not alive(process), timeout=12)


def save(state):
    temporary = STATE.with_suffix(".new")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(STATE)


def load():
    if not STATE.exists():
        raise RuntimeError("尚无本地会话，请先执行 up")
    return json.loads(STATE.read_text())


def registration_env(config):
    env = {key: os.environ[key] for key in ("PATH", "HOME", "LANG", "TMPDIR") if key in os.environ}
    env.update(NACOS_ADDR=config["nacos"], NAMESPACE=config["namespace"], GROUP=config["group"],
               SERVICE=config["service"], HUOBAO_HOST="127.0.0.1", HUOBAO_PORT=str(config["huobao_port"]),
               EPHEMERAL="true", HEARTBEAT_INTERVAL="3", VERSION="v1")
    return env


def hosts(config):
    query = urllib.parse.urlencode({"namespaceId": config["namespace"], "groupName": config["group"],
                                   "serviceName": config["service"], "healthyOnly": "false"})
    status, body, _ = fetch("http://" + config["nacos"] + "/nacos/v1/ns/instance/list?" + query)
    if status != 200:
        raise RuntimeError("Nacos 实例查询 HTTP %s" % status)
    return json.loads(body)["hosts"]


def registered(config):
    items = hosts(config)
    return (len(items) == 1 and items[0]["ip"] == "127.0.0.1" and items[0]["port"] == config["huobao_port"]
            and items[0]["healthy"] and items[0]["enabled"] and items[0]["ephemeral"])


def base(config):
    return "http://127.0.0.1:" + str(config["gateway_port"])


def huobao_base(config):
    return "http://127.0.0.1:" + str(config["huobao_port"])


def ready(config):
    return fetch(base(config) + "/readyz")[0] == 200


def registrar(config):
    return spawn(["/bin/bash", str(REGISTER), "watch"], "registrar", registration_env(config))


def up():
    previous = json.loads(STATE.read_text()) if STATE.exists() else None
    if previous and (alive(previous.get("gateway")) or alive(previous.get("registrar"))):
        if (alive(previous.get("gateway")) and alive(previous.get("registrar"))
                and registered(previous["config"]) and ready(previous["config"])):
            status(previous)
            return
        raise RuntimeError("存在未完整退出的会话，请先 down；不会覆盖已有进程")
    old = previous["config"] if previous else {}
    config = {"nacos": os.environ.get("NACOS_ADDR") or old.get("nacos", ""),
              "namespace": os.environ.get("NAMESPACE") or old.get("namespace", "public"),
              "group": os.environ.get("GROUP") or old.get("group", "HUOBAO_LOCAL_LWB"),
              "service": os.environ.get("SERVICE") or old.get("service", "huobao-local"),
              "huobao_port": int(os.environ.get("HUOBAO_PORT", old.get("huobao_port", 5679))),
              "gateway_port": int(os.environ.get("GATEWAY_PORT", old.get("gateway_port", 18080))),
              "gateway_dir": str(Path(os.environ.get("GATEWAY_DIR", old.get("gateway_dir", ROOT.parent / "newx-gateway"))).resolve())}
    address = urllib.parse.urlsplit("http://" + config["nacos"])
    if not address.hostname or not address.port or address.path or address.query or address.fragment or address.username:
        raise ValueError("请设置 NACOS_ADDR=host:port（不带协议和 /nacos）")
    if fetch(huobao_base(config) + "/api/v1/health")[0] != 200:
        raise RuntimeError("本机 Huobao 尚未就绪；请先启动后端，本工具不重启或迁移既有数据库")
    if hosts(config):
        raise RuntimeError("目标服务已有实例，拒绝覆盖；请更换 GROUP/SERVICE 或先清理本次会话")
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", config["gateway_port"]))
    RUNTIME.mkdir(parents=True, exist_ok=True)
    binary = RUNTIME / "newx-gateway"
    build_env = dict(os.environ, GOTOOLCHAIN="local", GOPROXY="off", GOSUMDB="off")
    subprocess.run(["go", "build", "-o", str(binary), "./cmd/server"], cwd=config["gateway_dir"],
                   env=build_env, check=True)
    gateway_config = {"ENTRY_HTTP_ADDR": "127.0.0.1:" + str(config["gateway_port"]), "ENTRY_ENV": "dev",
                      "APPS": ("huobao=nacos://" + config["service"] + "|/api/v1,"
                               "huobao-static=nacos://" + config["service"] + "|/static"),
                      "DISCOVERY": "nacos://" + config["nacos"], "DISCOVERY_NAMESPACE": config["namespace"],
                      "DISCOVERY_GROUP": config["group"], "DISCOVERY_REFRESH": "1s", "AUTH_ENABLED": "false",
                      "READYZ_PROBE_DOWNSTREAM": "true", "MCP_ENABLED": "false", "OPENAPI_ENABLED": "false",
                      "LOG_LEVEL": "info", "LOG_FORMAT": "json"}
    env_file = RUNTIME / "gateway.env"
    env_file.write_text("".join(key + "=" + value + "\n" for key, value in gateway_config.items()))
    env = {key: os.environ[key] for key in ("PATH", "HOME", "LANG", "TMPDIR") if key in os.environ}
    state = {"config": config}
    try:
        state["gateway"] = spawn([str(binary), "--env-file", str(env_file)], "gateway", env)
        save(state)
        state["registrar"] = registrar(config)
        save(state)
        wait_for("外部注册", lambda: registered(config))
        wait_for("网关就绪", lambda: ready(config))
    except BaseException:
        try:
            stop(state.get("registrar"))
        finally:
            try:
                stop(state.get("gateway"))
            finally:
                save(state)
        raise
    status(state)


def status(state=None):
    state = state or load()
    config = state["config"]
    result = {"gateway": base(config), "huobao": huobao_base(config), "nacos": config["nacos"],
              "namespace": config["namespace"], "group": config["group"], "service": config["service"],
              "gateway_running": alive(state.get("gateway")), "registrar_running": alive(state.get("registrar")),
              "runtime": str(RUNTIME)}
    result["instance_registered"] = registered(config)
    result["ready"] = ready(config) if result["gateway_running"] else False
    print(json.dumps(result, ensure_ascii=False, indent=2))


def down():
    state = load()
    try:
        stop(state.get("registrar"))
    finally:
        try:
            stop(state.get("gateway"))
        finally:
            save(state)
    wait_for("停止后 Nacos 实例摘除", lambda: not hosts(state["config"]))
    print("本地网关与注册守护已停止、实例已注销；未停止或修改原 Huobao 服务。")


def check():
    state = load()
    config = state["config"]
    if not alive(state.get("gateway")) or not alive(state.get("registrar")):
        raise RuntimeError("网关或注册守护未运行，请先 up")
    result_file = RUNTIME / "results.json"
    if result_file.exists():
        result_file.unlink()
    checks = []

    def passed(name, **values):
        item = dict(name=name, outcome="PASS", **values)
        checks.append(item)
        print(json.dumps(item, ensure_ascii=False), flush=True)

    assert registered(config), "实例未就绪或并非临时实例"
    assert ready(config), "网关未就绪"
    passed("真实 Nacos + 外部注册 + 本机 Huobao", ephemeral=True)
    env = registration_env(config)
    for _ in range(2):
        subprocess.run(["/bin/bash", str(REGISTER), "register"], env=env, check=True, stdout=subprocess.DEVNULL)
    assert registered(config), "重复注册产生冲突"
    passed("重复注册幂等", instances=1)
    for path in ("/healthz", "/readyz", "/web/huobao/v1/health"):
        code, _, _ = fetch(base(config) + path)
        assert code == 200, (path, code)
    passed("网关健康、就绪、Huobao 健康", http=200)
    for suffix in ("/dramas/stats", "/dramas?page=2&page_size=1"):
        direct_code, direct, _ = fetch(huobao_base(config) + "/api/v1" + suffix)
        request_id = "huobao-local-" + str(time.time_ns())
        proxy_code, proxied, headers = fetch(base(config) + "/web/huobao/v1" + suffix,
                                            headers={"X-Request-Id": request_id})
        assert direct_code == proxy_code == 200, (suffix, direct_code, proxy_code)
        assert json.loads(direct) == json.loads(proxied), "直连与网关业务响应不一致"
        normalized = {key.lower(): value for key, value in headers.items()}
        assert normalized.get("x-request-id") == request_id, "请求关联 ID 未保留"
        if "?" in suffix:
            pagination = json.loads(proxied)["data"]["pagination"]
            assert pagination["page"] == 2 and pagination["page_size"] == 1, "查询参数丢失"
        passed("只读业务响应及请求 ID 一致", path=suffix, bytes=len(proxied))
    time.sleep(36)
    assert alive(state["registrar"]) and registered(config) and ready(config), "心跳维持失败"
    passed("超过无心跳摘除窗口后仍可发现并转发", wait_seconds=36)
    try:
        stop(state["registrar"])
        wait_for("实例注销", lambda: not hosts(config))
        wait_for("网关摘除旧实例", lambda: fetch(base(config) + "/readyz")[0] == 503)
        assert fetch(huobao_base(config) + "/api/v1/health")[0] == 200, "真实 Huobao 不应被停止"
        code, body, _ = fetch(base(config) + "/web/huobao/v1/dramas/stats")
        assert code == 503 and json.loads(body)["code"] == 50201, "网关仍在转发旧实例"
        passed("注销及缓存刷新", huobao_http=200, readyz_http=503, proxy_http=503, code=50201)
    finally:
        if not alive(state["registrar"]):
            state["registrar"] = registrar(config)
            save(state)
        wait_for("重新注册", lambda: registered(config))
        wait_for("转发恢复", lambda: ready(config))
    assert fetch(base(config) + "/web/huobao/v1/dramas/stats")[0] == 200
    passed("恢复注册后真实业务访问", http=200)
    result = {"timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "outcome": "PASS", "checks": checks, "config": config,
              "scope": "真实本机 Huobao，只读 HTTP 业务查询；不含真实 yudao、生成或上传"}
    (RUNTIME / "results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print("联调 PASS；最终保留注册守护和网关运行，业务数据未写入。")


def main():
    parser = argparse.ArgumentParser(description="本机真实 Huobao 的 Nacos 外部注册与网关联调；复用已运行的 Huobao，不修改业务代码或数据库。")
    parser.add_argument("action", choices=("up", "down", "status", "check"))
    args = parser.parse_args()
    os.umask(0o077)
    RUNTIME.mkdir(parents=True, exist_ok=True)
    with (RUNTIME / "session.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("已有启动、停止或验收操作进行中") from None
        {"up": up, "down": down, "status": status, "check": check}[args.action]()


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, AssertionError, subprocess.CalledProcessError) as error:
        print("失败: " + str(error), file=sys.stderr)
        sys.exit(1)
