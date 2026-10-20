void (async () => {
  const { app } = await import('electron');
  const { default: assert } = await import('node:assert/strict');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const profile = process.env.CINEMA_CATALOG_PROFILE;
  const output = process.env.CINEMA_CATALOG_OUTPUT;
  if (
    !profile ||
    !path.resolve(profile).startsWith(`${os.tmpdir()}${path.sep}cinema-catalog-`) ||
    !output
  )
    throw new Error('Isolated catalog profile and output required.');
  app.setPath('userData', profile);
  const load = (name) =>
    import(pathToFileURL(path.resolve(__dirname, '..', 'dist-electron', name)).href);
  const evidence = {
    passed: false,
    startedAt: new Date().toISOString(),
    isolatedProfile: profile,
    providers: [],
    requests: [],
    fixturesUsed: false,
    replayUsed: false,
    realDiscordSends: 0,
    realLoginWrites: 0,
    realOsNotificationWrites: 0,
  };
  let service;
  try {
    await app.whenReady();
    app.dock?.hide();
    const [
      { CatalogService },
      { createCgvTransport },
      { createProviders },
      { koreanToday, normalizeTitle },
    ] = await Promise.all(
      ['catalog.js', 'cgvTransport.js', 'providers/index.js', 'validation.js'].map(load),
    );
    const raw = new Map();
    const observe = (transport, stack) => async (url, init) => {
      const request = {
        url,
        method: init?.method || 'GET',
        stack,
        startedAt: new Date().toISOString(),
      };
      evidence.requests.push(request);
      const response = await transport(url, init);
      request.status = response.status;
      request.finishedAt = new Date().toISOString();
      if (response.ok) {
        const body = await response.clone().json();
        if (url.includes('searchRegnList')) raw.set('cgvRegions', body);
        else if (url.includes('searchAtktTopPostrList')) raw.set('cgvMovies', body);
        else if (
          url.includes('selectBokdList') &&
          new URLSearchParams(String(init?.body)).get('onLoad') === 'Y'
        )
          raw.set('megabox', body);
        else if (
          url.includes('TicketingData') &&
          init?.body instanceof FormData &&
          JSON.parse(init.body.get('paramList')).MethodName === 'GetTicketingPageTOBE'
        )
          raw.set('lottecinema', body);
      }
      return response;
    };
    const nodeFetch = observe(fetch, 'Node');
    const cgvFetch = observe(createCgvTransport(), 'Chromium in-memory');
    service = new CatalogService(nodeFetch, cgvFetch);
    for (const provider of ['cgv', 'megabox', 'lottecinema']) {
      const catalog = await service.get({ provider, requestId: `live-${provider}` });
      assert.ok(
        catalog.regions.length >= 2 && catalog.theaters.length > 0 && catalog.movies.length > 0,
        `${provider}: nonempty full official catalog required`,
      );
      assert.equal(new Set(catalog.theaters.map((t) => t.id)).size, catalog.theaters.length);
      assert.equal(new Set(catalog.movies.map((m) => m.id)).size, catalog.movies.length);
      assert.ok(catalog.theaters.every((t) => catalog.regions.some((r) => r.id === t.regionId)));
      const twoRegions = catalog.regions
        .filter((r) => catalog.theaters.some((t) => t.regionId === r.id))
        .slice(0, 2)
        .map((r) => ({ region: r, theater: catalog.theaters.find((t) => t.regionId === r.id) }));
      assert.equal(twoRegions.length, 2);
      const animeSearch = catalog.movies.filter((m) =>
        normalizeTitle(m.title).includes('치이카와'),
      );
      assert.ok(animeSearch.length, `${provider}: actual anime title search required`);
      const body = raw.get(provider);
      const rawCounts =
        provider === 'cgv'
          ? {
              regions: raw.get('cgvRegions').data.length,
              theaters: raw.get('cgvRegions').data.reduce((n, r) => n + r.siteList.length, 0),
              movies: raw.get('cgvMovies').data.length,
            }
          : provider === 'megabox'
            ? {
                theaters: body.areaBrchList.length,
                movies: body.movieList.length,
                curatedMovies: body.crtnMovieList.length,
              }
            : {
                regions: body.CinemaDivison.AreaDivisions.Items.length,
                theaters: body.Cinemas.Cinemas.Items.length,
                movies: body.Movies.Movies.Items.length,
              };
      const originalMovies =
        provider === 'cgv'
          ? raw.get('cgvMovies').data.map((m) => String(m.movNo))
          : provider === 'megabox'
            ? [...body.movieList, ...body.crtnMovieList].map((m) => String(m.movieNo))
            : body.Movies.Movies.Items.map((m) => String(m.RepresentationMovieCode));
      assert.ok(animeSearch.every((m) => originalMovies.includes(m.id)));
      evidence.providers.push({
        provider,
        fetchedAt: catalog.fetchedAt,
        rawCounts,
        normalizedCounts: {
          regions: catalog.regions.length,
          theaters: catalog.theaters.length,
          movies: catalog.movies.length,
        },
        twoRegions,
        animeSearch,
        catalog,
        fixtureOrReplay: false,
      });
    }
    const mega = evidence.providers.find((p) => p.provider === 'megabox').catalog;
    const bookableIds = new Set(
      raw
        .get('megabox')
        .areaBrchList.filter((t) => t.brchFormAt === 'Y' && t.brchBokdUnableAt === 'N')
        .map((t) => String(t.brchNo)),
    );
    const seoulIds = new Set(mega.regions.filter((r) => r.name === '서울').map((r) => r.id));
    const candidates = mega.theaters.filter(
      (t) => !seoulIds.has(t.regionId) && bookableIds.has(t.id),
    );
    candidates.sort((a, b) => (a.id === '4121' ? -1 : b.id === '4121' ? 1 : 0));
    const today = koreanToday();
    const dates = [today, koreanToday(Date.parse(`${today}T12:00:00+09:00`) + 86400000)];
    const attempts = [];
    const providers = createProviders(nodeFetch, cgvFetch);
    let selected;
    for (const date of dates) {
      for (const theater of candidates.slice(0, 8)) {
        const rule = {
          id: 'nonseoul-probe',
          revision: 1,
          provider: 'megabox',
          theaterId: theater.id,
          theaterName: theater.name,
          movieTitle: '공개 상영 선택',
          date,
          format: 'ALL',
          isEnabled: true,
        };
        const sessions = await providers.megabox(rule, new AbortController().signal);
        assert.ok(
          sessions.every((s) => s.theaterId === theater.id),
          'Only selected non-Seoul theater may be returned',
        );
        const bookable = sessions.find((s) => s.isBookable && s.date === date);
        attempts.push({ date, theater, actualRows: sessions.length, bookable: !!bookable });
        if (bookable) {
          selected = { theater, session: bookable };
          break;
        }
      }
      if (selected) break;
    }
    evidence.nonSeoulMegabox = { dates, attempts, selected, omittedRegion: true };
    assert.ok(
      selected,
      'Non-Seoul MEGABOX must return an actual bookable showtime in the two-date range',
    );
    evidence.passed = evidence.providers.length === 3;
  } catch (error) {
    evidence.error = error.message;
  } finally {
    service?.dispose();
    evidence.finishedAt = new Date().toISOString();
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'catalog-probe.json'), JSON.stringify(evidence, null, 2));
    app.exit(evidence.passed ? 0 : 1);
  }
})();
