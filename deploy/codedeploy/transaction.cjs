'use strict';
const fail = (m) => {
  throw new Error(m);
};
const apiName = (port) => `mailhub-server-${port}`;
function portOf(raw) {
  const lines = raw
    .split(/\r?\n/)
    .map((x) => x.replace(/#.*/, '').trim())
    .filter(Boolean);
  const m =
    lines.length === 1 &&
    /^server\s+127\.0\.0\.1:(808[01])(?:\s+max_fails=\d+)?(?:\s+fail_timeout=\d+[smh]?)?\s*;$/.exec(
      lines[0],
    );
  return m ? Number(m[1]) : fail('Upstream must have exactly one reviewed loopback server');
}
function same(a, b) {
  return (
    a && b && ['name', 'id', 'pid', 'since', 'cwd', 'script', 'port'].every((k) => a[k] === b[k])
  );
}
function isRelease(app, release, port) {
  return (
    app &&
    app.name === apiName(port) &&
    app.cwd === release &&
    app.script === `${release}/dist/main.js` &&
    app.port === port &&
    app.apiMode
  );
}
function deploy(h, release) {
  let state = h.state();
  function restore() {
    const j = state.pending,
      oldPort = portOf(j.old),
      newPort = oldPort === 8080 ? 8081 : 8080;
    const disk = h.upstream();
    if (disk !== j.old && disk !== j.next)
      fail('Upstream changed outside transaction; manual recovery required');
    if (!same(h.live(oldPort), j.serving))
      fail('Original listener identity changed; manual recovery required');
    if (j.switching) {
      h.writeUpstream(j.old);
      h.nginxTest();
      h.reload();
    }
    h.probe('direct', oldPort);
    h.probe('ingress', oldPort);
    if (j.started) h.cleanCandidate(j.release, newPort);
    const restored = { ...state };
    delete restored.pending;
    h.save(restored);
    state = restored;
  }
  // Recover even if the last agent died between reload and commit.
  if (state.pending) restore();
  h.nginxTest();
  const old = h.upstream(),
    oldPort = portOf(old),
    port = oldPort === 8080 ? 8081 : 8080;
  const serving = h.live(oldPort);
  h.probe('direct', oldPort);
  h.probe('ingress', oldPort);
  h.prepare(); // clean install and full-tree compare even on active-SHA retries
  if (isRelease(serving, release, oldPort)) {
    if (h.upstream() !== old || !same(h.live(oldPort), serving))
      fail('Serving target changed during retry');
    h.probe('ingress', oldPort);
    return;
  }
  const slot = h.slot(port);
  if (slot && !same(slot, state.previous))
    fail('Inactive API slot is occupied by an unrecorded process');
  const reuse = isRelease(slot, release, port);
  if (slot && !reuse && !h.drained(port, state.switchedAt)) fail('Previous API is not drained');
  if (h.upstream() !== old || !same(h.live(oldPort), serving))
    fail('Serving target changed during preparation');
  const next = old.replace(
    /^([\t ]*server[\t ]+127\.0\.0\.1:)808[01](?=[\s;])/m,
    (_, prefix) => prefix + port,
  );
  if (portOf(next) !== port) fail('Could not safely replace upstream port');
  const j = { old, next, serving, release, started: false, switching: false };
  state = { ...state, pending: j };
  h.save(state);
  try {
    if (!reuse) {
      if (slot) h.removeRecorded(slot);
      if (h.slot(port)) fail('Candidate port no longer empty');
      j.started = true;
      h.save(state);
      h.start(release, port);
    }
    h.waitCandidate(release, port);
    h.probe('direct', port);
    if (
      !isRelease(h.live(port), release, port) ||
      h.upstream() !== old ||
      !same(h.live(oldPort), serving)
    )
      fail('API identity changed before switch');
    j.switching = true;
    h.save(state);
    h.writeUpstream(j.next);
    h.nginxTest();
    h.reload();
    h.probe('ingress', port);
    if (h.upstream() !== j.next || !isRelease(h.live(port), release, port))
      fail('Activated upstream identity mismatch');
    h.save({
      active: h.live(port),
      activeUpstream: j.next,
      previous: serving,
      switchedAt: Date.now(),
      previousUpstream: old,
    });
  } catch (cause) {
    try {
      restore();
    } catch (recovery) {
      throw new Error(
        `Rollback incomplete (${recovery.message}); journal retained. Original: ${cause.message}`,
      );
    }
    throw cause;
  }
}
module.exports = { deploy, portOf, apiName, isRelease, same };
