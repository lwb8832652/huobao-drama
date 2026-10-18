#!/usr/bin/env bash
set -euo pipefail
exec python3 - "$@" <<'PY'
import ipaddress
import json
import os
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def main():
    action = sys.argv[1] if len(sys.argv) == 2 else "status" if len(sys.argv) == 1 else ""
    if action not in ("register", "deregister", "status", "watch"):
        raise ValueError("用法: nacos-register.sh {register|deregister|status|watch}")
    addr = os.environ.get("NACOS_ADDR", "")
    parsed = urllib.parse.urlsplit("http://" + addr)
    if not parsed.hostname or not parsed.port or parsed.path or parsed.query or parsed.fragment or parsed.username:
        raise ValueError("NACOS_ADDR 必须为 host:port，不带协议或 /nacos")
    namespace = os.environ.get("NAMESPACE") or "public"
    group = os.environ.get("GROUP") or "DEFAULT_GROUP"
    service = os.environ.get("SERVICE") or "huobao"
    cluster = os.environ.get("CLUSTER") or "DEFAULT"
    ephemeral = os.environ.get("EPHEMERAL", "true")
    if ephemeral not in ("true", "false") or (action == "watch" and ephemeral != "true"):
        raise ValueError("EPHEMERAL 必须为 true/false；watch 必须使用 true")
    interval = float(os.environ.get("HEARTBEAT_INTERVAL", "3"))
    if not 1 <= interval <= 5:
        raise ValueError("HEARTBEAT_INTERVAL 必须介于 1 到 5 秒")
    common = {"namespaceId": namespace, "groupName": group, "serviceName": service}
    instance = dict(common, clusterName=cluster, ephemeral=ephemeral)
    health_url = ""
    if action != "status":
        host = os.environ.get("HUOBAO_HOST", "")
        ip = ipaddress.ip_address(host)
        if ip.is_unspecified or ip.is_multicast:
            raise ValueError("HUOBAO_HOST 必须为网关可达的明确实例 IP")
        port = int(os.environ.get("HUOBAO_PORT", "5679"))
        if not 1 <= port <= 65535:
            raise ValueError("HUOBAO_PORT 超出有效范围")
        instance.update(ip=host, port=port)
        url_host = "[" + host + "]" if ip.version == 6 else host
        health_url = os.environ.get("HEALTH_URL") or "http://%s:%s/api/v1/health" % (url_host, port)
    metadata = {"version": os.environ.get("VERSION", "v1"), "owner": "huobao-external-register"}
    weight = float(os.environ.get("WEIGHT", "1"))
    if not 0 < weight <= 10000:
        raise ValueError("WEIGHT 必须大于 0 且不超过 10000")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(path, method="GET", params=None):
        values = dict(params or {})
        token = os.environ.get("NACOS_ACCESS_TOKEN")
        if token:
            values["accessToken"] = token
        query = urllib.parse.urlencode(values)
        url = "http://" + addr + "/nacos" + path
        payload = None
        if method in ("GET", "DELETE"):
            url += "?" + query
        else:
            payload = query.encode()
        req = urllib.request.Request(url, data=payload, method=method)
        try:
            with opener.open(req, timeout=6) as response:
                body = response.read(2 << 20).decode()
                if response.status != 200:
                    raise RuntimeError("Nacos HTTP %s" % response.status)
                return body
        except urllib.error.HTTPError as error:
            raise RuntimeError("Nacos HTTP %s；请检查地址、权限和实例类型" % error.code) from None
        except urllib.error.URLError:
            raise RuntimeError("无法访问 Nacos，请检查网络") from None

    def healthy():
        try:
            with opener.open(health_url, timeout=2) as response:
                return response.status == 200 and json.load(response).get("status") == "ok"
        except (OSError, ValueError, urllib.error.URLError):
            return False

    def register():
        params = dict(instance, weight=weight, enabled="true", healthy="true", metadata=json.dumps(metadata))
        if request("/v1/ns/instance", "POST", params).strip().lower() != "ok":
            raise RuntimeError("Nacos 未确认注册成功")

    def deregister():
        if request("/v1/ns/instance", "DELETE", instance).strip().lower() != "ok":
            raise RuntimeError("Nacos 未确认注销成功")

    def report(message):
        print(message, flush=True)

    if action == "status":
        data = json.loads(request("/v1/ns/instance/list", params=dict(common, healthyOnly="false")))
        report(json.dumps(data, ensure_ascii=False))
        return
    if action == "deregister":
        deregister()
        report("注销成功 (%s / %s, ephemeral=%s)" % (group, service, ephemeral))
        return
    if action == "register":
        if not healthy():
            raise RuntimeError("Huobao 健康检查失败，拒绝注册")
        register()
        report("注册成功 (%s / %s, ephemeral=%s)" % (group, service, ephemeral))
        return

    registered = False
    heartbeat_count = 0

    def stop(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while True:
            try:
                if not healthy():
                    if registered:
                        deregister()
                        registered = False
                        report("Huobao 不健康，已注销；等待恢复")
                else:
                    if not registered:
                        register()
                        registered = True
                        report("注册并守护 (%s / %s, ephemeral=true)" % (group, service))
                    beat = {"serviceName": group + "@@" + service, "ip": instance["ip"],
                            "port": instance["port"], "cluster": cluster, "weight": weight,
                            "metadata": metadata, "scheduled": True}
                    result = json.loads(request("/v1/ns/instance/beat", "PUT", dict(instance, beat=json.dumps(beat))))
                    if result.get("code") != 10200:
                        registered = False
                        raise RuntimeError("Nacos 心跳未确认，将重新注册")
                    heartbeat_count += 1
                    if heartbeat_count == 1 or heartbeat_count % 10 == 0:
                        report("心跳已确认 count=%s" % heartbeat_count)
            except (OSError, ValueError, RuntimeError) as error:
                report(str(error))
            time.sleep(interval)
    except KeyboardInterrupt:
        pass
    finally:
        if registered:
            deregister()
            report("守护停止，已注销")


try:
    main()
except (OSError, ValueError, RuntimeError) as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
PY
