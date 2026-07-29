const byId = (id) => document.getElementById(id);
let config = null;

async function api(path, init = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  if (response.status === 401) {
    window.location.assign('/login');
    throw new Error('登录状态已失效');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const error = new Error(body?.error?.message || `请求失败 (${response.status})`);
    error.code = body?.error?.code;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function setMessage(value, isError = false) {
  const element = byId('message');
  element.textContent = value;
  element.classList.toggle('error', isError);
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function render(next) {
  config = next;
  byId('schema-version').textContent = next.schemaVersion;
  byId('revision').textContent = next.revision;
  byId('default-profile').textContent = next.routing.defaultProfileId;
  byId('log-level').textContent = next.observability.logLevel;
  byId('runtime-status').textContent = `Revision ${next.revision}`;
  byId('runtime-status').classList.add('ready');

  byId('inbound-vless').checked = next.inbound.vless.enabled;
  byId('inbound-trojan').checked = next.inbound.trojan.enabled;
  byId('inbound-ss').checked = next.inbound.shadowsocks.enabled;
  byId('ss-method').value = next.inbound.shadowsocks.method;
  byId('transport-ws').checked = next.transports.websocket.enabled;
  byId('ws-path').value = next.transports.websocket.path;
  byId('transport-grpc').checked = next.transports.grpc.enabled;
  byId('grpc-service').value = next.transports.grpc.serviceName;
  byId('transport-xhttp').checked = next.transports.xhttp.enabled;
  byId('xhttp-path').value = next.transports.xhttp.path;
  byId('dns-enabled').checked = next.dns.enabled;
  byId('doh-url').value = next.dns.dohUrl;
  byId('dns-timeout').value = next.dns.timeoutMs;
  byId('dns-max').value = next.dns.maxMessageBytes;
  byId('profiles').value = pretty(next.egressProfiles);
  byId('routing-default').value = next.routing.defaultProfileId;
  byId('block-private').checked = next.routing.blockPrivateTargets;
  byId('routing-rules').value = pretty(next.routing.rules);
  byId('subscription-enabled').checked = next.subscription.enabled;
  byId('subscription-base').value = next.subscription.publicBaseUrl || '';
  byId('subscription-formats').value = JSON.stringify(next.subscription.formats);
  byId('camouflage-url').value = next.site.camouflageUrl || '';
  byId('observability-level').value = next.observability.logLevel;
  byId('observability-retention').value = next.observability.retention;
}

async function loadConfig() {
  setMessage('正在加载配置…');
  const body = await api('/api/admin/v1/config');
  render(body.data.config);
  setMessage('配置已加载');
}

function collectConfig() {
  const next = structuredClone(config);
  next.inbound.vless.enabled = byId('inbound-vless').checked;
  next.inbound.trojan.enabled = byId('inbound-trojan').checked;
  next.inbound.shadowsocks.enabled = byId('inbound-ss').checked;
  next.inbound.shadowsocks.method = byId('ss-method').value;
  next.transports.websocket.enabled = byId('transport-ws').checked;
  next.transports.websocket.path = byId('ws-path').value.trim();
  next.transports.grpc.enabled = byId('transport-grpc').checked;
  next.transports.grpc.serviceName = byId('grpc-service').value.trim();
  next.transports.xhttp.enabled = byId('transport-xhttp').checked;
  next.transports.xhttp.path = byId('xhttp-path').value.trim();
  next.dns.enabled = byId('dns-enabled').checked;
  next.dns.dohUrl = byId('doh-url').value.trim();
  next.dns.timeoutMs = Number(byId('dns-timeout').value);
  next.dns.maxMessageBytes = Number(byId('dns-max').value);
  next.egressProfiles = JSON.parse(byId('profiles').value);
  next.routing.defaultProfileId = byId('routing-default').value.trim();
  next.routing.blockPrivateTargets = byId('block-private').checked;
  next.routing.rules = JSON.parse(byId('routing-rules').value);
  next.subscription.enabled = byId('subscription-enabled').checked;
  const publicBaseUrl = byId('subscription-base').value.trim();
  if (publicBaseUrl) next.subscription.publicBaseUrl = publicBaseUrl;
  else delete next.subscription.publicBaseUrl;
  next.subscription.formats = JSON.parse(byId('subscription-formats').value);
  const camouflageUrl = byId('camouflage-url').value.trim();
  if (camouflageUrl) next.site.camouflageUrl = camouflageUrl;
  else delete next.site.camouflageUrl;
  next.observability.logLevel = byId('observability-level').value;
  next.observability.retention = Number(byId('observability-retention').value);
  return next;
}

function collectCredentials() {
  const ref = byId('credential-ref').value.trim();
  if (!ref) return undefined;
  if (byId('credential-delete').checked) return { [ref]: null };
  const password = byId('credential-password').value;
  if (!password) return undefined;
  const username = byId('credential-user').value;
  return { [ref]: { ...(username ? { username } : {}), password } };
}

byId('config-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const next = collectConfig();
    const credentials = collectCredentials();
    const body = await api('/api/admin/v1/config', {
      method: 'PUT',
      body: JSON.stringify({
        config: next,
        expectedRevision: config.revision,
        ...(credentials ? { credentials } : {}),
      }),
    });
    byId('credential-password').value = '';
    byId('credential-delete').checked = false;
    render(body.data.config);
    setMessage('配置已保存');
  } catch (error) {
    if (error.code === 'CONFIG_REVISION_CONFLICT') {
      setMessage('配置已被其他会话更新，正在重新加载…', true);
      await loadConfig();
      return;
    }
    setMessage(error instanceof Error ? error.message : '保存失败', true);
  }
});

byId('reload').addEventListener('click', () => loadConfig().catch((error) => setMessage(error.message, true)));
byId('logout').addEventListener('click', async () => {
  await api('/api/admin/v1/session', { method: 'DELETE' });
  window.location.assign('/login');
});
byId('preview').addEventListener('click', async () => {
  const format = encodeURIComponent(byId('preview-format').value);
  try {
    const body = await api(`/api/admin/v1/subscriptions/preview?format=${format}`);
    byId('preview-output').textContent =
      `订阅地址：${body.data.subscriptionUrl}\n\n${body.data.content}`;
  } catch (error) {
    byId('preview-output').textContent = error.message;
  }
});
byId('refresh-logs').addEventListener('click', async () => {
  try {
    const body = await api('/api/admin/v1/logs');
    byId('logs-output').textContent = pretty(body.data.logs);
  } catch (error) {
    byId('logs-output').textContent = error.message;
  }
});
byId('clear-logs').addEventListener('click', async () => {
  if (!window.confirm('确定清空安全日志？')) return;
  await api('/api/admin/v1/logs', { method: 'DELETE' });
  byId('logs-output').textContent = '日志已清空';
});
byId('test-profile').addEventListener('click', async () => {
  const id = encodeURIComponent(byId('routing-default').value.trim());
  try {
    const body = await api(`/api/admin/v1/profiles/${id}/test`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    setMessage(body.data?.message || '连接测试成功');
  } catch (error) {
    setMessage(error instanceof Error ? error.message : '连接测试失败', true);
  }
});

loadConfig().catch((error) => setMessage(error.message, true));
