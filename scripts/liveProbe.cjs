void (async () => {
  const { app } = await import('electron');
  const { default: assert } = await import('node:assert/strict');
  const { mkdir, writeFile, readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const { execFileSync } = await import('node:child_process');
  const profile = process.env.CINEMA_LIVE_PROFILE;
  if (!profile || !path.resolve(profile).startsWith(`${os.tmpdir()}${path.sep}cinema-live-`))
    throw new Error('Isolated temporary live profile required.');
  app.setPath('userData', profile);
  const root = path.resolve(__dirname, '..');
  const output = process.env.CINEMA_LIVE_OUTPUT;
  const evidence = {
    passed: false,
    startedAt: new Date().toISOString(),
    isolatedProfile: profile,
    providers: [],
    requests: [],
    realDiscordSends: 0,
    realLocalPopupRequests: 0,
    realLoginWrites: 0,
    realOsNotificationWrites: 0,
    fixturesUsed: false,
    replayUsed: false,
  };
  const load = (name) => import(pathToFileURL(path.join(root, 'dist-electron', name)).href);
  await (async () => {
    await app.whenReady();
    app.dock?.hide();
    const [
      { createProviders },
      { createCgvTransport },
      { Store },
      { SecretStore },
      { Engine },
      { koreanToday, sessionIdentity },
    ] = await Promise.all(
      [
        'providers/index.js',
        'cgvTransport.js',
        'store.js',
        'secretStore.js',
        'engine.js',
        'validation.js',
      ].map(load),
    );
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    assert.equal(process.versions.electron, pkg.devDependencies.electron);
    evidence.electron = process.versions.electron;
    evidence.platform = process.platform;
    evidence.codeState = {
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      workingTree: execFileSync('git', ['status', '--porcelain'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    };
    let phase = 'selection';
    const observedFetch = (fetcher, stack) => async (url, init) => {
      const request = {
        url,
        method: init?.method || 'GET',
        stack,
        phase,
        startedAt: new Date().toISOString(),
      };
      evidence.requests.push(request);
      try {
        const response = await fetcher(url, init);
        request.finishedAt = new Date().toISOString();
        request.status = response.status;
        const payload = await response.clone().json();
        request.actualRows = Array.isArray(payload.data)
          ? payload.data.length
          : Array.isArray(payload.movieFormList)
            ? payload.movieFormList.length
            : Array.isArray(payload.PlaySeqs?.Items)
              ? payload.PlaySeqs.Items.length
              : null;
        if (init?.body instanceof FormData)
          request.operation = JSON.parse(init.body.get('paramList')).MethodName;
        return response;
      } catch (error) {
        request.finishedAt = new Date().toISOString();
        request.error = String(error.message).slice(0, 180);
        throw error;
      }
    };
    const nodeFetch = observedFetch(fetch, 'Node');
    const providers = createProviders(
      nodeFetch,
      observedFetch(createCgvTransport(), 'Chromium in-memory'),
    );
    const base = (provider) => ({
      id: `live-${provider}`,
      revision: 1,
      provider,
      theaterId: { cgv: '0013', megabox: '1372', lottecinema: '1016' }[provider],
      theaterName: '공개 시간표 선택',
      movieTitle: '공개 시간표 선택',
      date: koreanToday(),
      format: 'ALL',
      isEnabled: true,
    });
    const startDate = koreanToday();
    const dates = [startDate, koreanToday(Date.parse(`${startDate}T12:00:00+09:00`) + 86400000)];
    evidence.selectionDates = dates;
    for (const provider of ['cgv', 'megabox', 'lottecinema']) {
      phase = `${provider}:selection`;
      let rule = base(provider);
      let selected;
      let selectionRows = 0;
      let lotteMovies;
      if (provider === 'lottecinema') {
        const form = new FormData();
        form.set(
          'paramList',
          JSON.stringify({
            MethodName: 'GetTicketingPageTOBE',
            channelType: 'HO',
            osType: 'W',
            osVersion: 'CinemaBar/0.1',
            memberOnNo: '0',
          }),
        );
        const response = await nodeFetch(
          'https://www.lottecinema.co.kr/LCWS/Ticketing/TicketingData.aspx',
          {
            method: 'POST',
            body: form,
            headers: { Accept: 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(15000),
          },
        );
        assert.equal(response.status, 200);
        const catalog = await response.json();
        assert.ok(Array.isArray(catalog.Movies?.Movies?.Items));
        lotteMovies = catalog.Movies.Movies.Items.slice(0, 15);
      }
      const selectionAttempts = [];
      for (const date of dates) {
        rule = { ...base(provider), date };
        const candidates =
          provider === 'lottecinema'
            ? lotteMovies.map((movie) => ({
                ...rule,
                movieTitle: movie.MovieNameKR,
                movieId: String(movie.RepresentationMovieCode),
              }))
            : [rule];
        for (const candidate of candidates) {
          const sessions = await providers[provider](candidate, new AbortController().signal);
          selected = sessions.find(
            (s) => s.isBookable && s.theaterId === candidate.theaterId && s.date === date,
          );
          selectionAttempts.push({
            date,
            movieId: candidate.movieId,
            actualRows: sessions.length,
            selected: !!selected,
          });
          if (selected) {
            selectionRows = sessions.length;
            rule = candidate;
            break;
          }
        }
        if (selected) break;
      }
      assert.ok(selected, `${provider}: must select at least one actual bookable showtime`);
      rule = {
        ...rule,
        theaterName: selected.theaterName,
        movieTitle: selected.movieTitle,
        movieId: selected.movieId,
      };
      const store = new Store(path.join(profile, provider));
      await store.load();
      await store.mutate((state) => {
        state.rules = [rule];
      });
      const secrets = new SecretStore({
        isAvailable: () => false,
        encrypt: () => {
          throw new Error('No real secrets in live probe');
        },
        decrypt: () => {
          throw new Error('No real secrets in live probe');
        },
      });
      const reads = [];
      let mockDiscord = 0;
      let mockLocal = 0;
      const engine = new Engine(store, secrets, {
        providers: {
          ...providers,
          [provider]: async (input, signal) => {
            const sessions = await providers[provider](input, signal);
            reads.push({ at: new Date().toISOString(), sessions });
            return sessions;
          },
        },
        deliver: async () => {
          mockDiscord++;
          return { kind: 'sent' };
        },
        notifyLocal: async () => {
          mockLocal++;
          return { kind: 'requested' };
        },
        isLocalAlertSupported: () => true,
      });
      try {
        phase = `${provider}:engine-first`;
        await engine.refresh();
        const first = structuredClone(store.state.progress[rule.id]);
        assert.ok(
          first?.lastSuccess &&
            first.count >= 1 &&
            Object.keys(first.baseline).length >= 1 &&
            !first.error,
        );
        assert.equal(mockDiscord, 0);
        assert.equal(mockLocal, 0);
        phase = `${provider}:engine-second`;
        await engine.refresh();
        const second = structuredClone(store.state.progress[rule.id]);
        assert.ok(second.lastSuccess >= first.lastSuccess && second.count >= 1 && !second.error);
        assert.equal(reads.length, 2);
        assert.equal(store.state.rules[0].movieId, selected.movieId);
        const newBookable = reads[1].sessions.filter(
          (s) =>
            s.isBookable &&
            s.movieId === selected.movieId &&
            s.theaterId === rule.theaterId &&
            s.date === rule.date &&
            first.baseline[sessionIdentity(s)] !== true,
        );
        assert.equal(mockDiscord, 0);
        assert.equal(mockLocal, Math.min(10, new Set(newBookable.map(sessionIdentity)).size));
        evidence.providers.push({
          provider,
          rule,
          selected,
          selectionRows,
          selectionAttempts,
          requestCount: evidence.requests.filter((r) => r.phase.startsWith(`${provider}:`)).length,
          first,
          second,
          reads,
          mockDiscordSends: mockDiscord,
          mockLocalRequests: mockLocal,
          naturallyNewBookable: newBookable.length,
          fixtureOrReplay: false,
        });
      } finally {
        engine.stop();
      }
    }
    evidence.passed = evidence.providers.length === 3;
  })()
    .catch((error) => {
      evidence.error = error.message;
    })
    .finally(async () => {
      evidence.finishedAt = new Date().toISOString();
      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, 'live-probe.json'), JSON.stringify(evidence, null, 2));
      app.exit(evidence.passed ? 0 : 1);
    });
})();
