// ==UserScript==
// @name         DuoVanguard Companion v4.2 (Auto-Solver + Chess Bot + Max)
// @namespace    http://127.0.0.1:8791/
// @version      4.2.0
// @description  Unified In-Browser Companion: Full React 18 Fiber + Redux Direct Auto-Solver (Lessons, Stories, Kanji Strokes, Cloze, Tables), Live Chess Bot vs Oscar/PvP (Best Move Arrow + Auto-Move + Instant Win), Fake Duolingo Max, & Local Dashboard Bridge.
// @author       Dzakiudin (jakijekiiii)
// @match        https://*.duolingo.com/*
// @match        https://*.duolingo.cn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (['blog', 'simg-ssl', 'englishtest', 'schools', 'store', 'podcast'].some(s => new RegExp(`(?:^|\\.)${s}\\.`).test(window.location.hostname))) {
    return;
  }

  const STORAGE_KEY = 'duovanguard_companion_cfg_v42';
  const defaultCfg = {
    fakeMax: false,
    autoSolveAll: false,
    randomSolveSpeed: false,
    solveSpeedMs: 450,
    muteAudio: false,
    solvedCount: 0,
    chessAutoPlay: false,
    chessShowArrow: true,
    chessUseCloud: true,
    chessPerspective: 'auto', // 'auto' | 'w' | 'b'
    localDashboardUrl: 'http://127.0.0.1:8791',
  };

  function loadCfg() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? { ...defaultCfg, ...JSON.parse(raw) } : { ...defaultCfg };
    } catch {
      return { ...defaultCfg };
    }
  }

  function saveCfg(next = cfg) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {}
  }

  let cfg = loadCfg();
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ============================================================================
  // 1. FAKE DUOLINGO MAX (FETCH + XHR INTERCEPTOR AT DOCUMENT-START)
  // ============================================================================
  function mutateMaxPayload(data) {
    if (!data || typeof data !== 'object') return data;
    data.hasPlus = true;
    if (!Array.isArray(data.subscriptionConfigs)) data.subscriptionConfigs = [];
    data.subscriptionConfigs.push({
      vendor: 'STRIPE',
      isFreeTrial: false,
      inGracePeriod: false,
      productId: 'com.duolingo.max.subscription.12month',
      expirationEpoch: 1999999999000,
      PauseStart: null,
      pauseEnd: null,
      autoRenew: true,
      tier: 'MAX',
      type: 'GOLD',
      status: 'ACTIVE',
      createdAt: 1700000000000,
    });
    if (!data.shopItems || typeof data.shopItems !== 'object') data.shopItems = {};
    data.shopItems.gold_subscription = {
      itemName: 'gold_subscription',
      subscriptionInfo: {
        vendor: 'STRIPE',
        renewing: true,
        isFreeTrialPeriod: false,
        expectedExpiration: 1999999999000,
        type: 'GOLD',
        tier: 'MAX',
      },
    };
    if (data.trackingProperties && typeof data.trackingProperties === 'object') {
      data.trackingProperties.has_item_gold_subscription = true;
      data.trackingProperties.has_item_immersive_subscription = true;
      data.trackingProperties.has_plus = true;
      data.trackingProperties.has_gold_subscription = true;
      data.trackingProperties.has_max = true;
    }
    return data;
  }

  function installMaxInterceptor() {
    if (window.__duoVanguardMaxHooked) return;
    window.__duoVanguardMaxHooked = true;

    const origFetch = window.fetch.bind(window);
    window.fetch = async function (...args) {
      const response = await origFetch(...args);
      try {
        if (!cfg.fakeMax) return response;
        const reqUrl = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (reqUrl.includes('/users/') && (reqUrl.includes('fields=') || /\/users\/\d+(\?|$)/.test(reqUrl))) {
          const clone = response.clone();
          const data = await clone.json();
          mutateMaxPayload(data);
          return new Response(JSON.stringify(data), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
      } catch {}
      return response;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._dhUrl = typeof url === 'string' ? url : String(url || '');
      return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('readystatechange', function () {
        if (!cfg.fakeMax) return;
        if (this.readyState === 4 && this._dhUrl && this._dhUrl.includes('/users/')) {
          try {
            const raw = JSON.parse(this.responseText);
            mutateMaxPayload(raw);
            const modText = JSON.stringify(raw);
            Object.defineProperty(this, 'responseText', { value: modText, configurable: true });
            Object.defineProperty(this, 'response', { value: modText, configurable: true });
          } catch {}
        }
      });
      return origSend.apply(this, args);
    };
  }

  installMaxInterceptor();

  // ============================================================================
  // 2. REACT 18 FIBER & REDUX STORE EXTRACTION (CONTAINER + FIBER + REDUX)
  // ============================================================================
  const DEFAULT_REACT_MAIN_ELEMENT_CLASS = '_3yE3H';
  const STORY_REACT_MAIN_ELEMENT_CLASS = '_3TJzR';

  function getDomFiber(dom) {
    if (!dom) return null;
    const rawDom = dom.wrappedJSObject || dom;
    const keys = Object.keys(rawDom);
    const fiberKey = keys.find(
      k =>
        k.startsWith('__reactFiber$') ||
        k.startsWith('__reactContainer$') ||
        k.startsWith('__reactInternalInstance$'),
    );
    if (!fiberKey) return null;
    const val = rawDom[fiberKey];
    return val?.current || val || null;
  }

  function findReact(dom, traverseUp = 1) {
    if (!dom) return null;
    const domFiber = getDomFiber(dom);
    if (!domFiber) return null;
    if (domFiber._currentElement) {
      let compFiber = domFiber._currentElement._owner;
      for (let i = 0; i < traverseUp && compFiber; i++) {
        compFiber = compFiber._currentElement?._owner;
      }
      return compFiber?._instance || null;
    }
    const getCompFiber = fiber => {
      let parentFiber = fiber?.return;
      while (parentFiber && typeof parentFiber.type === 'string') {
        parentFiber = parentFiber.return;
      }
      return parentFiber;
    };
    let compFiber = getCompFiber(domFiber);
    for (let i = 0; i < traverseUp && compFiber; i++) {
      compFiber = getCompFiber(compFiber);
    }
    return compFiber?.stateNode || (compFiber?.memoizedProps ? { props: compFiber.memoizedProps } : null);
  }

  function extractStoreFromFiber(node) {
    if (!node) return null;
    const candidates = [
      node.memoizedProps?.store,
      node.memoizedProps?.value?.store,
      node.pendingProps?.store,
      node.pendingProps?.value?.store,
      node.stateNode?.store,
      node.memoizedState?.element?.props?.store,
      node.memoizedState?.memoizedState?.store,
      node.dependencies?.firstContext?.memoizedValue?.store,
    ];
    for (const st of candidates) {
      if (st && typeof st.getState === 'function' && typeof st.dispatch === 'function') {
        return st;
      }
    }
    return null;
  }

  let cachedReduxStore = null;
  function getReduxStore() {
    if (cachedReduxStore && typeof cachedReduxStore.getState === 'function') {
      return cachedReduxStore;
    }

    const roots = [
      document.getElementById('root'),
      document.querySelector('[data-test="player-next"]'),
      document.querySelector('[data-test^="challenge"]'),
      document.querySelector('[data-test="stories-player-continue"]'),
      document.querySelector('button'),
      ...Array.from(document.querySelectorAll('#root, #root > *, main, button')).slice(0, 35),
    ].filter(Boolean);

    for (const r of roots) {
      const startFiber = getDomFiber(r);
      if (!startFiber) continue;

      // 1. Walk UP (.return) to <Provider store={e}>
      let cur = startFiber;
      let upSteps = 0;
      while (cur && upSteps < 60) {
        upSteps++;
        const st = extractStoreFromFiber(cur);
        if (st) {
          cachedReduxStore = st;
          return st;
        }
        cur = cur.return;
      }

      // 2. Breadth-first scan DOWN (.child / .sibling) from #root container
      const queue = [startFiber];
      let visited = 0;
      while (queue.length && visited < 120) {
        const node = queue.shift();
        visited++;
        const st = extractStoreFromFiber(node);
        if (st) {
          cachedReduxStore = st;
          return st;
        }
        if (node.child) queue.push(node.child);
        if (node.sibling) queue.push(node.sibling);
      }
    }
    return null;
  }

  function findChallengeObject() {
    // 1. Cek langsung dari Redux Store (player.session.challenges[player.currentIndex] atau stories)
    try {
      const store = getReduxStore();
      const state = store?.getState?.();
      const player = state?.player;
      if (player?.session?.challenges && typeof player.currentIndex === 'number') {
        const ch = player.session.challenges[player.currentIndex];
        if (ch) return ch;
      }
      const storySession = state?.stories?.storySession?.challengeSession;
      if (storySession?.challenges && typeof storySession.currentChallengeIndex === 'number') {
        const sch = storySession.challenges[storySession.currentChallengeIndex];
        if (sch) return sch;
      }
    } catch {}

    // 2. Cek Story class (_3TJzR) atau Lesson class (_3yE3H) legacy
    const isStory = document.getElementsByClassName('FmlUF').length > 0 || window.location.pathname.includes('/stories');
    if (isStory) {
      const storyEl = document.getElementsByClassName(STORY_REACT_MAIN_ELEMENT_CLASS)[0];
      const storySol = findReact(storyEl, 0)?.props?.currentChallenge;
      if (storySol) return storySol;
    }

    const mainEl = document.getElementsByClassName(DEFAULT_REACT_MAIN_ELEMENT_CLASS)[0];
    if (mainEl) {
      for (const up of [1, 0, 2, 3]) {
        const sol = findReact(mainEl, up)?.props?.currentChallenge;
        if (sol) return sol;
      }
    }

    // 3. Walk up dari elemen challenge di DOM
    const candidates = [
      document.querySelector('[data-test^="challenge"]'),
      document.querySelector('[data-test*="challenge-"]'),
      document.querySelector('[data-test="player-next"]'),
      document.getElementById('session/PlayerFooter'),
      document.querySelector('[data-test="stories-player-continue"]'),
    ].filter(Boolean);

    for (const el of candidates) {
      let f = getDomFiber(el);
      let steps = 0;
      while (f && steps < 55) {
        steps++;
        const p = f.memoizedProps || f.stateNode?.props;
        if (p?.currentChallenge) return p.currentChallenge;
        if (p?.challenge && typeof p.challenge === 'object' && p.challenge.type) return p.challenge;
        if (p?.slide && typeof p.slide === 'object' && p.slide.type) return p.slide;
        f = f.return;
      }
    }

    return null;
  }

  // ============================================================================
  // 2B. DIRECT REDUX CHALLENGE SOLVER (EXTRACTED FROM DUOLINGO WEB BUNDLE)
  // ============================================================================
  function computeReduxGuess(ch) {
    if (!ch || !ch.type) return undefined;
    const t = ch.type;

    if (
      [
        'assist',
        'characterIntro',
        'characterSelect',
        'definition',
        'dialogue',
        'form',
        'gapFill',
        'listenComprehension',
        'listenIsolation',
        'patternTapComplete',
        'readComprehension',
        'reverseAssist',
        'sameDifferent',
        'select',
        'selectPronunciation',
        'selectTranscription',
        'transliterationAssist',
      ].includes(t)
    ) {
      return ch.correctIndex ?? 0;
    }

    if (t === 'judge') {
      return ch.correctIndices?.[0] ?? ch.correctIndex ?? 0;
    }

    if (
      [
        'characterMatch',
        'extendedMatch',
        'extendedListenMatch',
        'listenMatch',
        'match',
        'radioBinary',
        'radioImageSelect',
        'radioListenMatch',
        'radioListenRecognize',
        'radioSelect',
      ].includes(t)
    ) {
      return ch.correctIndices || true;
    }

    if (t === 'characterPuzzle' || t === 'svgPuzzle') {
      return { choices: ch.correctIndices || [] };
    }

    if (t === 'characterTrace') {
      return { currentStrokeIndex: (ch.strokes || []).length };
    }

    if (t === 'characterWrite') {
      return {
        currentStrokeIndex: (ch.strokes || []).filter(s => s.strokeDrawMode !== 'PREDRAWN').length,
        skippedCurrentStroke: false,
      };
    }

    if (t === 'completeReverseTranslation') {
      return {
        translatedWords: (ch.displayTokens || []).map(tok => (tok.isBlank ? tok.text : '')),
        typedSentence: (ch.displayTokens || []).map(tok => tok.text).join(''),
      };
    }

    if (t === 'freeResponse') {
      return ch.prompt || 'ok';
    }

    if (t === 'listen' || t === 'writeComprehension') {
      return ch.prompt || ch.correctSolutions?.[0] || '';
    }

    if (t === 'listenComplete') {
      return (ch.displayTokens || []).map(tok => (tok.isBlank ? tok.text : ''));
    }

    if (t === 'listenTap') {
      return {
        tapTranscriptions: ch.correctIndices || [],
        transcription: ch.prompt || ch.correctSolutions?.[0] || '',
      };
    }

    if (['orderTapComplete', 'tapComplete', 'tapDescribe', 'syllableTap', 'syllableListenTap'].includes(t)) {
      return ch.correctIndices || [];
    }

    if (['partialListen', 'partialReverseTranslate', 'typeComplete'].includes(t)) {
      return (ch.displayTokens || []).filter(tok => tok.isBlank).map(tok => tok.text).join('');
    }

    if (t === 'translate') {
      return {
        tapTranslations: ch.correctIndices || [],
        translation: ch.correctSolutions?.[0] || ch.prompt || '',
      };
    }

    if (t === 'transliterate') {
      return {
        transliteration: ch.correctSolutions?.[0] || '',
      };
    }

    if (t === 'speak' || t === 'listenSpeak') {
      return {
        score: (ch.threshold || 0.5) + 0.5,
        usedGuesses: 1,
      };
    }

    if (t === 'name') {
      const sol = ch.correctSolutions?.[0] || '';
      const artIdx = (ch.articles || []).findIndex(a => sol.startsWith(a));
      const art = artIdx >= 0 ? ch.articles[artIdx] : '';
      return {
        article: artIdx,
        translation: sol.slice(art.length).trim(),
      };
    }

    if (['tapCloze', 'tapClozeTable', 'tapCompleteTable', 'typeCloze', 'typeClozeTable', 'typeCompleteTable'].includes(t)) {
      if (Array.isArray(ch.displayTableTokens)) {
        return ch.displayTableTokens.map(row =>
          row.map(cell =>
            (cell || []).map(tok => {
              if (typeof tok.damageStart === 'number') return tok.text.slice(tok.damageStart);
              if (tok.isBlank) return tok.text;
              return '';
            }),
          ),
        );
      }
      if (Array.isArray(ch.displayTokens)) {
        return ch.displayTokens.map(tok => {
          if (typeof tok.damageStart === 'number') return tok.text.slice(tok.damageStart);
          if (tok.isBlank) return tok.text;
          return '';
        });
      }
    }

    if (['chessStar', 'chessNormal', 'chessFictionalBoard'].includes(t)) {
      return { gradingState: { type: 'correct' } };
    }

    if (['chessMatch', 'chessMiniMatch', 'chessPvpMatch'].includes(t)) {
      return {
        matchState: { status: 'completed', outcome: 'win' },
        gradingState: { type: 'correct' },
      };
    }

    return ch.correctIndices ?? ch.correctIndex ?? ch.correctSolutions?.[0] ?? true;
  }

  function solveViaRedux() {
    try {
      const store = getReduxStore();
      if (!store) return { ok: false, reason: 'no-store' };
      const state = store.getState();

      // 1. Cek apakah sedang di Story Session
      const storyChallengeSession = state?.stories?.storySession?.challengeSession;
      if (storyChallengeSession?.challenges) {
        const sch = storyChallengeSession.challenges[storyChallengeSession.currentChallengeIndex];
        if (sch) {
          if (sch.type === 'multiple-choice' && typeof sch.correctAnswerIndex === 'number') {
            store.dispatch({ type: 'stories/SELECT_MULTIPLE_CHOICE', index: sch.correctAnswerIndex, selectMethod: 'CLICK' });
            return { ok: true, mode: 'story-mc', challenge: sch };
          }
          if ((sch.type === 'select-phrases' || sch.type === 'point-to-phrase') && typeof sch.correctAnswerIndex === 'number') {
            store.dispatch({ type: 'stories/SELECT_PHRASE', optionIndex: sch.correctAnswerIndex, selectMethod: 'CLICK' });
            return { ok: true, mode: 'story-phrase', challenge: sch };
          }
        }
      }

      // 2. Cek apakah sedang di Lesson / Practice Player
      const player = state?.player;
      if (!player || !player.session?.challenges) {
        return { ok: false, reason: 'no-player-session' };
      }

      const idx = player.currentIndex;
      const ch = player.session.challenges[idx];
      const chState = player.challengeStates?.[idx];
      if (!ch) return { ok: false, reason: 'no-current-challenge' };

      // Jika sudah berstatus BLAMING / SHOWING (sudah dinilai), tinggal klik Continue
      if (player.status === 'BLAMING' || player.status === 'SHOWING') {
        return { ok: true, mode: 'already-graded', challenge: ch };
      }

      // Jika dialogue atau readComprehension masih di layar bacaan awal, majukan dulu ke pertanyaan
      if (
        (ch.type === 'dialogue' && chState && chState.currentDialogueIndex < (ch.dialogue?.length || 0)) ||
        (ch.type === 'readComprehension' && chState && !chState.finishedPassage)
      ) {
        for (let step = 0; step < 10; step++) {
          const curSt = store.getState()?.player?.challengeStates?.[idx];
          if (ch.type === 'dialogue' && curSt?.currentDialogueIndex >= (ch.dialogue?.length || 0)) break;
          if (ch.type === 'readComprehension' && curSt?.finishedPassage) break;
          store.dispatch({ type: 'CONTINUE_CURRENT_CHALLENGE' });
        }
      }

      const reduxGuess = computeReduxGuess(ch);
      if (reduxGuess !== undefined) {
        store.dispatch({
          type: 'CHALLENGE_GUESS_CHANGE',
          value: reduxGuess,
        });
      }

      return { ok: true, mode: 'redux-guess', challenge: ch, reduxGuess, store };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  function forceGradeViaRedux(store, reduxGuess) {
    try {
      const st = store || getReduxStore();
      if (!st) return false;
      const player = st.getState()?.player;
      if (!player || player.status === 'BLAMING' || player.status === 'SHOWING') return true;
      st.dispatch({
        type: 'UPDATE_GRADED_CHALLENGE',
        gradingResult: {
          correct: true,
          guess: reduxGuess ?? true,
        },
        skipped: false,
        timeTaken: 850,
      });
      return true;
    } catch {
      return false;
    }
  }

  // ============================================================================
  // 3. FULL LESSON & STORY AUTO-SOLVER (DUOLINGO PRO 3.1 + DUOHACKER V2.6)
  // ============================================================================
  function getCleanButtonText(button) {
    if (!button) return '';
    const rubyElements = button.querySelectorAll('ruby');
    if (rubyElements.length > 0) {
      let text = '';
      rubyElements.forEach(ruby => {
        const baseTextElements = ruby.querySelectorAll('span[lang]:not(rt)');
        if (baseTextElements.length > 0) {
          baseTextElements.forEach(span => { text += span.textContent; });
        } else {
          const clone = ruby.cloneNode(true);
          clone.querySelectorAll('rt, rp').forEach(el => el.remove());
          text += clone.textContent;
        }
      });
      return text.trim();
    }
    const textElement = button.querySelector('[data-test="challenge-tap-token-text"]');
    if (textElement) return textElement.innerText.trim();
    const clone = button.cloneNode(true);
    clone.querySelectorAll('[data-test="challenge-tap-token-num"], rt, rp').forEach(el => el.remove());
    return clone.innerText.replace(/\n/g, '').trim();
  }

  function determineChallengeType() {
    try {
      if (!window.sol) return 'error';
      if (
        ['chessMatch', 'chessMiniMatch', 'chessPvpMatch', 'chessStar', 'chessNormal', 'chessFictionalBoard'].includes(window.sol.type) ||
        String(window.sol.type || '').toLowerCase().includes('chess')
      ) {
        return 'Chess Challenge';
      }
      if (document.getElementsByClassName('FmlUF').length > 0) {
        if (window.sol.type === 'arrange') return 'Story Arrange';
        if (window.sol.type === 'multiple-choice' || window.sol.type === 'select-phrases') return 'Story Multiple Choice';
        if (window.sol.type === 'point-to-phrase') return 'Story Point to Phrase';
        if (window.sol.type === 'match') return 'Story Pairs';
      } else {
        if (document.querySelectorAll('[data-test*="challenge-speak"]').length > 0) return 'Challenge Speak';
        if (window.sol.type === 'syllableTap') return 'Syllable Tap';
        if (window.sol.type === 'syllableListenTap') return 'Syllable Listen Tap';
        if (window.sol.type === 'tapCompleteTable') return 'Tap Complete Table';
        if (window.sol.type === 'typeCloze') return 'Type Cloze';
        if (window.sol.type === 'typeClozeTable') return 'Type Cloze Table';
        if (window.sol.type === 'tapClozeTable') return 'Tap Cloze Table';
        if (window.sol.type === 'typeCompleteTable') return 'Type Complete Table';
        if (window.sol.type === 'patternTapComplete') return 'Pattern Tap Complete';
        if (window.sol.type === 'completeReverseTranslation') return 'Complete Reverse Translation';
        if (document.querySelectorAll('[data-test*="challenge-name"]').length > 0 && document.querySelectorAll('[data-test="challenge-choice"]').length > 0) {
          return 'Challenge Name';
        }
        if (window.sol.type === 'listenMatch' || document.querySelectorAll('[data-test*="challenge-listenMatch"]').length > 0) return 'Listen Match';
        if (document.querySelectorAll('[data-test="challenge challenge-characterWrite"]').length > 0) {
          if (document.querySelector('g._25Ktp')) return 'Character Write Drag';
          if (document.querySelectorAll('path._1e5Zt').length > 0) return 'Character Write Draw';
          return 'Character Write Freehand';
        }
        if (document.querySelectorAll('[data-test="challenge challenge-listenSpeak"], [data-test*="challenge-listenSpeak"]').length > 0) {
          return 'Listen Speak';
        }
        if (document.querySelectorAll('[data-test="challenge-choice"]').length > 0) {
          if (document.querySelectorAll('[data-test="challenge-text-input"]').length > 0) {
            return 'Challenge Choice with Text Input';
          }
          return 'Challenge Choice';
        }
        if (document.querySelectorAll('[data-test$="challenge-tap-token"], [data-test*="challenge-tap-token"]:not(span)').length > 0) {
          if (window.sol.pairs !== undefined) return 'Pairs';
          if (window.sol.correctTokens !== undefined) return 'Tokens Run';
          if (window.sol.correctIndices !== undefined) return 'Indices Run';
        }
        if (document.querySelectorAll('[data-test="challenge-tap-token-text"]').length > 0) return 'Fill in the Gap';
        if (document.querySelectorAll('[data-test="challenge-text-input"]').length > 0) return 'Challenge Text Input';
        if (document.querySelectorAll('[data-test*="challenge-partialReverseTranslate"]').length > 0) return 'Partial Reverse';
        if (document.querySelectorAll('textarea[data-test="challenge-translate-input"]').length > 0) return 'Challenge Translate Input';
        if (document.querySelectorAll('[data-test*="challenge-listen"]').length > 0) return 'Listen Challenge';
        return false;
      }
    } catch {
      return 'error';
    }
    return false;
  }

  async function handleChallenge(challengeType) {
    if (challengeType === 'Chess Challenge') {
      await runChessBotStep(true);
      return;
    }

    if (['Challenge Speak', 'Listen Match', 'Listen Speak', 'Listen Challenge'].includes(challengeType)) {
      const buttonSkip = document.querySelector('button[data-test="player-skip"]');
      if (buttonSkip) buttonSkip.click();
      return;
    }

    if (challengeType === 'Challenge Choice' || challengeType === 'Challenge Choice with Text Input') {
      if (challengeType === 'Challenge Choice with Text Input') {
        const elm = document.querySelectorAll('[data-test="challenge-text-input"]')[0];
        if (elm) {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          let ans = window.sol.correctSolutions
            ? (window.sol.correctSolutions[0].split(/(?<=^\S+)\s/)[1] || window.sol.correctSolutions[0])
            : (window.sol.displayTokens ? window.sol.displayTokens.find(t => t.isBlank)?.text : window.sol.prompt);
          if (window.sol.prompt && window.sol.correctSolutions?.[0] && (window.sol.prompt.includes('...') || window.sol.prompt.includes('___'))) {
            const parts = window.sol.prompt.split('...');
            if (parts.length > 1) {
              const full = window.sol.correctSolutions[0];
              for (let i = 0; i < parts.length - 1; i++) {
                if (full.includes(parts[i])) {
                  ans = full.replace(parts[i], '').trim();
                  break;
                }
              }
            }
          }
          nativeSetter.call(elm, ans || '');
          elm.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } else {
        const choices = document.querySelectorAll('[data-test="challenge-choice"]');
        if (choices[window.sol.correctIndex]) choices[window.sol.correctIndex].click();
      }
    } else if (challengeType === 'Pairs') {
      const nl = document.querySelectorAll('[data-test*="challenge-tap-token"]:not(span)');
      window.sol.pairs?.forEach(pair => {
        for (let i = 0; i < nl.length; i++) {
          if (nl[i].disabled) continue;
          const buttonText = getCleanButtonText(nl[i]).toLowerCase();
          const candidates = [pair.transliteration, pair.character, pair.learningToken, pair.fromToken]
            .filter(Boolean)
            .map(s => String(s).toLowerCase().trim());
          if (candidates.includes(buttonText)) {
            nl[i].click();
          }
        }
      });
    } else if (challengeType === 'Story Pairs') {
      const nl = document.querySelectorAll('[data-test*="challenge-tap-token"]:not(span)');
      const map = new Map();
      for (let i = 0; i < nl.length; i++) {
        map.set(getCleanButtonText(nl[i]).toLowerCase(), nl[i]);
      }
      for (const key in window.sol.dictionary || {}) {
        if (Object.prototype.hasOwnProperty.call(window.sol.dictionary, key)) {
          const value = window.sol.dictionary[key];
          const keyPart = key.split(':')[1]?.toLowerCase().trim();
          const normVal = String(value).toLowerCase().trim();
          const el1 = map.get(keyPart);
          const el2 = map.get(normVal);
          if (el1 && !el1.disabled) el1.click();
          if (el2 && !el2.disabled) el2.click();
        }
      }
    } else if (challengeType === 'Tap Complete Table') {
      const solutionRows = window.sol.displayTableTokens.slice(1);
      const tableRowElements = document.querySelectorAll('tbody tr');
      const wordBank = document.querySelector('div[data-test="word-bank"]');
      const wordBankButtons = wordBank ? wordBank.querySelectorAll('button[data-test*="-challenge-tap-token"]') : [];
      const usedIndexes = new Set();

      solutionRows.forEach((solutionRow, rowIndex) => {
        const answerCellData = solutionRow[1];
        const correctToken = answerCellData?.find(token => token.isBlank);
        if (correctToken) {
          const correctAnswerText = correctToken.text;
          const currentRowEl = tableRowElements[rowIndex];
          const buttons = currentRowEl ? currentRowEl.querySelectorAll('button[data-test*="-challenge-tap-token"]') : [];
          let clicked = false;
          for (const button of buttons) {
            if (getCleanButtonText(button) === correctAnswerText && !button.disabled) {
              button.click();
              clicked = true;
              break;
            }
          }
          if (!clicked && wordBankButtons.length > 0) {
            for (let i = 0; i < wordBankButtons.length; i++) {
              if (usedIndexes.has(i)) continue;
              const button = wordBankButtons[i];
              if (getCleanButtonText(button) === correctAnswerText && !button.disabled) {
                button.click();
                usedIndexes.add(i);
                break;
              }
            }
          }
        }
      });
    } else if (challengeType === 'Tokens Run') {
      const allTokens = document.querySelectorAll('[data-test$="challenge-tap-token"], div[data-test="word-bank"] [data-test*="challenge-tap-token"]:not(span)');
      const correctTokens = window.sol.correctTokens || [];
      const clickedTokens = [];
      correctTokens.forEach(correctToken => {
        const matching = Array.from(allTokens).filter(el => getCleanButtonText(el) === String(correctToken).trim());
        if (matching.length > 0) {
          const matchIdx = clickedTokens.filter(t => getCleanButtonText(t) === String(correctToken).trim()).length;
          const target = matching[matchIdx] || matching[0];
          target.click();
          clickedTokens.push(target);
        }
      });
    } else if (challengeType === 'Indices Run' || challengeType === 'Fill in the Gap') {
      const btns = document.querySelectorAll('div[data-test="word-bank"] [data-test*="challenge-tap-token"]:not(span), [data-test$="challenge-tap-token"]');
      window.sol.correctIndices?.forEach(index => {
        if (btns[index]) btns[index].click();
      });
    } else if (challengeType === 'Challenge Text Input') {
      const elm = document.querySelectorAll('[data-test="challenge-text-input"]')[0];
      if (elm) {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        let correctAnswer = window.sol.correctSolutions
          ? window.sol.correctSolutions[0]
          : (window.sol.displayTokens ? window.sol.displayTokens.find(t => t.isBlank)?.text : window.sol.prompt);
        if (window.sol.prompt && window.sol.correctSolutions?.[0] && (window.sol.prompt.includes('...') || window.sol.prompt.includes('___'))) {
          const parts = window.sol.prompt.split('...');
          if (parts.length > 1) {
            const full = window.sol.correctSolutions[0];
            for (let i = 0; i < parts.length - 1; i++) {
              if (full.includes(parts[i])) {
                correctAnswer = full.replace(parts[i], '').trim();
                break;
              }
            }
          }
        }
        nativeSetter.call(elm, correctAnswer || '');
        elm.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (challengeType === 'Partial Reverse') {
      const elm = document.querySelector('[data-test*="challenge-partialReverseTranslate"]')?.querySelector('span[contenteditable]');
      if (elm) {
        const nativeNodeSetter = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent').set;
        const ans = window.sol?.displayTokens?.filter(t => t.isBlank)?.map(t => t.text)?.join('') || '';
        nativeNodeSetter.call(elm, ans);
        elm.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (challengeType === 'Challenge Translate Input') {
      const elm = document.querySelector('textarea[data-test="challenge-translate-input"]');
      if (elm) {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        const ans = window.sol.correctSolutions ? window.sol.correctSolutions[0] : window.sol.prompt;
        nativeSetter.call(elm, ans || '');
        elm.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (challengeType === 'Challenge Name') {
      const articles = window.sol.articles || [];
      const correctSol = window.sol.correctSolutions?.[0] || '';
      const matchingArticle = articles.find(a => correctSol.startsWith(a));
      if (matchingArticle !== undefined) {
        const matchingIndex = articles.indexOf(matchingArticle);
        const remainingValue = correctSol.substring(matchingArticle.length);
        const selectedEl = document.querySelector(`[data-test="challenge-choice"]:nth-child(${matchingIndex + 1})`);
        if (selectedEl) selectedEl.click();
        const elm = document.querySelector('[data-test="challenge-text-input"]');
        if (elm) {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(elm, remainingValue);
          elm.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    } else if (challengeType === 'Type Cloze') {
      const input = document.querySelector('input[type="text"].b4jqk, [data-test*="challenge"] input[type="text"]');
      if (input) {
        const targetToken = window.sol.displayTokens?.find(t => t.damageStart !== undefined);
        const correctWord = targetToken?.text || '';
        const correctEnding = typeof targetToken?.damageStart === 'number' ? correctWord.slice(targetToken.damageStart) : '';
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(input, correctEnding);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else if (challengeType === 'Type Cloze Table') {
      const tableRows = document.querySelectorAll('tbody tr');
      window.sol.displayTableTokens?.slice(1).forEach((rowTokens, i) => {
        const answerCell = rowTokens[1]?.find(t => typeof t.damageStart === 'number');
        if (answerCell && tableRows[i]) {
          const input = tableRows[i].querySelector('input[type="text"]');
          if (!input) return;
          const correctEnding = answerCell.text.slice(answerCell.damageStart);
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(input, correctEnding);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    } else if (challengeType === 'Tap Cloze Table') {
      const tableRows = document.querySelectorAll('tbody tr');
      window.sol.displayTableTokens?.slice(1).forEach((rowTokens, i) => {
        const answerCell = rowTokens[1]?.find(t => typeof t.damageStart === 'number');
        if (!answerCell || !tableRows[i]) return;
        const wordBank = document.querySelector('[data-test="word-bank"], .eSgkc');
        const wordButtons = wordBank ? Array.from(wordBank.querySelectorAll('button[data-test*="challenge-tap-token"]:not([aria-disabled="true"])')) : [];
        const correctEnding = answerCell.text.slice(answerCell.damageStart);
        let endingMatched = '';
        for (const btn of wordButtons) {
          const btnText = getCleanButtonText(btn);
          if (!correctEnding.startsWith(endingMatched + btnText)) continue;
          btn.click();
          endingMatched += btnText;
          if (endingMatched === correctEnding) break;
        }
      });
    } else if (challengeType === 'Type Complete Table') {
      const tableRows = document.querySelectorAll('tbody tr');
      window.sol.displayTableTokens?.slice(1).forEach((rowTokens, i) => {
        const answerCell = rowTokens[1]?.find(t => t.isBlank);
        if (!answerCell || !tableRows[i]) return;
        const input = tableRows[i].querySelector('input[type="text"]');
        if (!input) return;
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(input, answerCell.text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    } else if (challengeType === 'Pattern Tap Complete') {
      const wordBank = document.querySelector('[data-test="word-bank"], .eSgkc');
      if (wordBank) {
        const correctText = window.sol.choices?.[window.sol.correctIndex ?? 0];
        const buttons = Array.from(wordBank.querySelectorAll('button[data-test*="challenge-tap-token"]:not([aria-disabled="true"])'));
        const target = buttons.find(btn => getCleanButtonText(btn) === correctText);
        if (target) target.click();
      }
    } else if (challengeType === 'Complete Reverse Translation') {
      const blankTokens = window.sol.displayTokens?.filter(t => t.isBlank) || [];
      const inputFields = document.querySelectorAll('[data-test="challenge-text-input"]');
      inputFields.forEach((input, index) => {
        if (blankTokens[index]) {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(input, blankTokens[index].text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    } else if (challengeType === 'Character Write Drag' || challengeType === 'Character Write Draw' || challengeType === 'Character Write Freehand') {
      const strokes = challengeType === 'Character Write Freehand'
        ? (window.sol.strokes || []).filter(s => s.strokeDrawMode === 'FREEHAND')
        : (window.sol.strokes || []);
      const createEv = (type, x, y, buttons) => new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, buttons, button: 0 });
      const norm = str => (str ? str.replace(/\s/g, '') : '');

      for (let i = 0; i < strokes.length; i++) {
        const targetPathData = norm(strokes[i].path);
        const pathSel = challengeType === 'Character Write Freehand' ? 'path._22UPm' : 'path._1e5Zt';
        const handleSel = challengeType === 'Character Write Drag'
          ? 'g._25Ktp'
          : challengeType === 'Character Write Draw'
            ? 'g._1h31R:not(._25Ktp)'
            : 'svg.o1rqi';

        let pathEl = null, handleEl = null, tries = 0;
        while ((!pathEl || !handleEl) && tries < 40) {
          tries++;
          const candidates = document.querySelectorAll(pathSel);
          pathEl = Array.from(candidates).find(p => norm(p.getAttribute('d')) === targetPathData) || candidates[0];
          handleEl = document.querySelector(handleSel);
          if (!pathEl || !handleEl) await sleep(15);
        }
        if (!pathEl || !handleEl) break;

        const matrix = pathEl.getScreenCTM();
        const len = pathEl.getTotalLength();
        const start = pathEl.getPointAtLength(0).matrixTransform(matrix);
        const end = pathEl.getPointAtLength(len).matrixTransform(matrix);

        handleEl.dispatchEvent(createEv('mousedown', start.x, start.y, 1));
        document.dispatchEvent(createEv('mousedown', start.x, start.y, 1));
        for (let s = 1; s <= 10; s++) {
          const p = pathEl.getPointAtLength((s / 10) * len).matrixTransform(matrix);
          const mv = createEv('mousemove', p.x, p.y, 1);
          handleEl.dispatchEvent(mv);
          document.dispatchEvent(mv);
        }
        const finalMv = createEv('mousemove', end.x, end.y, 1);
        handleEl.dispatchEvent(finalMv);
        document.dispatchEvent(finalMv);
        await sleep(8);
        handleEl.dispatchEvent(createEv('mouseup', end.x, end.y, 0));
        document.dispatchEvent(createEv('mouseup', end.x, end.y, 0));
      }
    } else if (challengeType === 'Syllable Tap' || challengeType === 'Syllable Listen Tap') {
      const correctIndices = window.sol.correctIndices || [];
      const choicesData = window.sol.choices || [];
      const domButtons = Array.from(document.querySelectorAll('[data-test="word-bank"] [data-test$="challenge-tap-token"]'));
      correctIndices.forEach(idx => {
        const correctText = choicesData[idx]?.text;
        const match = domButtons.find(btn => getCleanButtonText(btn) === correctText);
        if (match) match.click();
      });
    } else if (challengeType === 'Story Arrange') {
      const choices = document.querySelectorAll('[data-test*="challenge-tap-token"]:not(span)');
      for (let i = 0; i < (window.sol.phraseOrder || []).length; i++) {
        choices[window.sol.phraseOrder[i]]?.click();
      }
    } else if (challengeType === 'Story Multiple Choice') {
      const choices = document.querySelectorAll('[data-test="stories-choice"]');
      choices[window.sol.correctAnswerIndex]?.click();
    } else if (challengeType === 'Story Point to Phrase') {
      const choices = document.querySelectorAll('[data-test="challenge-tap-token-text"]');
      let correctIdx = -1;
      for (let i = 0; i < (window.sol.parts || []).length; i++) {
        if (window.sol.parts[i].selectable === true) {
          correctIdx++;
          if (window.sol.correctAnswerIndex === i) {
            choices[correctIdx]?.parentElement?.click();
          }
        }
      }
    }
  }

  let isSolvingStep = false;
  async function solveCurrentQuestion() {
    if (isSolvingStep) return;
    isSolvingStep = true;
    try {
      if (cfg.muteAudio) applyMuteState();

      // 1. Jalankan Direct Redux Solver terlebih dahulu (menangani React 18 + Redux modern)
      const reduxRes = solveViaRedux();
      window.sol = reduxRes?.challenge || findChallengeObject();

      // 2. Jika sedang di papan catur Duolingo (Vs Oscar / PvP / Puzzle) dan belum dinilai
      if (
        (!window.sol && detectChessBoardElement()) ||
        (window.sol && determineChallengeType() === 'Chess Challenge' && reduxRes?.mode !== 'already-graded')
      ) {
        await runChessBotStep(true);
      }

      // 3. Jalankan juga DOM Click/Input Solver sebagai pendamping visual
      const challengeType = window.sol ? determineChallengeType() : 'error';
      if (challengeType && challengeType !== 'error' && reduxRes?.mode !== 'already-graded') {
        await handleChallenge(challengeType);
      }

      await sleep(75);

      // 4. Cek apakah tombol Check / Continue sudah aktif. Jika belum aktif, paksa UPDATE_GRADED_CHALLENGE di Redux!
      let btn1 =
        document.querySelector('[data-test="player-next"]') ||
        document.querySelector('[data-test="stories-player-continue"]') ||
        document.querySelector('[data-test="stories-player-done"]');

      const isBtnDisabled = btn => !btn || btn.getAttribute('aria-disabled') === 'true' || btn.disabled;

      if (isBtnDisabled(btn1) && reduxRes?.store) {
        forceGradeViaRedux(reduxRes.store, reduxRes.reduxGuess);
        await sleep(65);
        btn1 =
          document.querySelector('[data-test="player-next"]') ||
          document.querySelector('[data-test="stories-player-continue"]') ||
          document.querySelector('[data-test="stories-player-done"]');
      }

      // 5. Klik 1: Check (Periksa) atau Continue jika sudah ter-grade
      if (!isBtnDisabled(btn1)) {
        btn1.click();
        cfg.solvedCount++;
        saveCfg();
        updateOverlayCounter();
      }

      // 6. Klik 2: Continue (Lanjutkan) setelah evaluasi Check
      await sleep(140);
      const stAfter = getReduxStore()?.getState?.()?.player;
      if (stAfter && stAfter.status === 'GUESSING' && reduxRes?.store) {
        // Jika klik pertama belum mengubah status dari GUESSING (misal soal kompleks), paksa grade benar
        forceGradeViaRedux(reduxRes.store, reduxRes.reduxGuess);
        await sleep(65);
      }

      const btn2 =
        document.querySelector('[data-test="player-next"]') ||
        document.querySelector('[data-test="stories-player-continue"]') ||
        document.querySelector('[data-test="stories-player-done"]');
      if (!isBtnDisabled(btn2)) {
        btn2.click();
      }
    } catch (e) {
      console.warn('[DuoVanguard] Solve error:', e);
    } finally {
      isSolvingStep = false;
    }
  }

  window.findReact = findReact;
  window.solveCurrentQuestion = solveCurrentQuestion;

  // ============================================================================
  // 4. BUILT-IN DUOLINGO CHESS BOT (VS OSCAR, PUZZLES & PVP)
  // ============================================================================
  const FILES = 'abcdefgh';
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const PIECE_VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

  function rcToSq(r, c) { return FILES[c] + String(8 - r); }
  function sqToRc(sq) {
    if (!sq || sq.length < 2) return null;
    const c = FILES.indexOf(sq[0].toLowerCase());
    const r = 8 - parseInt(sq[1], 10);
    return (c >= 0 && c < 8 && r >= 0 && r < 8) ? [r, c] : null;
  }

  function parseFenLocal(fen = START_FEN) {
    const parts = String(fen || START_FEN).trim().split(/\s+/);
    const rows = (parts[0] || '').split('/');
    if (rows.length !== 8) return null;
    const board = Array.from({ length: 8 }, () => Array(8).fill(null));
    for (let r = 0; r < 8; r++) {
      let c = 0;
      for (const ch of rows[r]) {
        if (ch >= '1' && ch <= '8') c += parseInt(ch, 10);
        else {
          board[r][c] = { type: ch.toLowerCase(), color: ch === ch.toUpperCase() ? 'w' : 'b' };
          c++;
        }
      }
    }
    return {
      board,
      turn: parts[1] === 'b' ? 'b' : 'w',
      castling: parts[2] || '-',
      ep: parts[3] && parts[3] !== '-' ? parts[3] : null,
    };
  }

  function inB(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

  function isAttacked(board, r, c, byCol) {
    const pDir = byCol === 'w' ? 1 : -1;
    for (const dc of [-1, 1]) {
      if (inB(r + pDir, c + dc) && board[r + pDir][c + dc]?.color === byCol && board[r + pDir][c + dc]?.type === 'p') return true;
    }
    for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
      if (inB(r + dr, c + dc) && board[r + dr][c + dc]?.color === byCol && board[r + dr][c + dc]?.type === 'n') return true;
    }
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if ((dr || dc) && inB(r + dr, c + dc) && board[r + dr][c + dc]?.color === byCol && board[r + dr][c + dc]?.type === 'k') return true;
      }
    }
    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      let cr = r + dr, cc = c + dc;
      while (inB(cr, cc)) {
        const p = board[cr][cc];
        if (p) { if (p.color === byCol && (p.type === 'r' || p.type === 'q')) return true; break; }
        cr += dr; cc += dc;
      }
    }
    for (const [dr, dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
      let cr = r + dr, cc = c + dc;
      while (inB(cr, cc)) {
        const p = board[cr][cc];
        if (p) { if (p.color === byCol && (p.type === 'b' || p.type === 'q')) return true; break; }
        cr += dr; cc += dc;
      }
    }
    return false;
  }

  function inCheck(board, col) {
    const opp = col === 'w' ? 'b' : 'w';
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (board[r][c]?.color === col && board[r][c]?.type === 'k') {
          return isAttacked(board, r, c, opp);
        }
      }
    }
    return false;
  }

  function applyMoveLocal(st, m) {
    const b = st.board.map(row => row.map(cell => (cell ? { ...cell } : null)));
    const [fr, fc] = sqToRc(m.from);
    const [tr, tc] = sqToRc(m.to);
    const p = b[fr][fc];
    if (!p) return st;
    if (p.type === 'p' && m.to === st.ep && !b[tr][tc]) b[fr][tc] = null;
    if (p.type === 'k' && Math.abs(tc - fc) === 2) {
      if (tc === 6) { b[tr][5] = b[tr][7]; b[tr][7] = null; }
      else if (tc === 2) { b[tr][3] = b[tr][0]; b[tr][0] = null; }
    }
    b[fr][fc] = null;
    b[tr][tc] = { type: m.promotion || p.type, color: p.color };
    return {
      board: b,
      turn: st.turn === 'w' ? 'b' : 'w',
      castling: st.castling,
      ep: p.type === 'p' && Math.abs(tr - fr) === 2 ? rcToSq((fr + tr) / 2, fc) : null,
    };
  }

  function genLegalMovesLocal(st) {
    const pseudo = [];
    const { board, turn, ep } = st;
    const opp = turn === 'w' ? 'b' : 'w';

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (!p || p.color !== turn) continue;
        const from = rcToSq(r, c);
        if (p.type === 'p') {
          const dir = turn === 'w' ? -1 : 1;
          const startR = turn === 'w' ? 6 : 1;
          const promoR = turn === 'w' ? 0 : 7;
          const r1 = r + dir;
          if (inB(r1, c) && !board[r1][c]) {
            if (r1 === promoR) pseudo.push({ from, to: rcToSq(r1, c), piece: 'p', promotion: 'q' });
            else {
              pseudo.push({ from, to: rcToSq(r1, c), piece: 'p' });
              if (r === startR && inB(r + dir * 2, c) && !board[r + dir * 2][c]) {
                pseudo.push({ from, to: rcToSq(r + dir * 2, c), piece: 'p' });
              }
            }
          }
          for (const dc of [-1, 1]) {
            if (!inB(r1, c + dc)) continue;
            const t = board[r1][c + dc];
            const toSq = rcToSq(r1, c + dc);
            if ((t && t.color === opp) || (ep && toSq === ep)) {
              pseudo.push({ from, to: toSq, piece: 'p', captured: t?.type || 'p', promotion: r1 === promoR ? 'q' : undefined });
            }
          }
        } else if (p.type === 'n') {
          for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
            if (inB(r + dr, c + dc) && board[r + dr][c + dc]?.color !== turn) {
              pseudo.push({ from, to: rcToSq(r + dr, c + dc), piece: 'n', captured: board[r + dr][c + dc]?.type });
            }
          }
        } else if (p.type === 'k') {
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if ((dr || dc) && inB(r + dr, c + dc) && board[r + dr][c + dc]?.color !== turn) {
                pseudo.push({ from, to: rcToSq(r + dr, c + dc), piece: 'k', captured: board[r + dr][c + dc]?.type });
              }
            }
          }
        } else {
          const dirs = [];
          if (p.type === 'r' || p.type === 'q') dirs.push([-1,0],[1,0],[0,-1],[0,1]);
          if (p.type === 'b' || p.type === 'q') dirs.push([-1,-1],[-1,1],[1,-1],[1,1]);
          for (const [dr, dc] of dirs) {
            let tr = r + dr, tc = c + dc;
            while (inB(tr, tc)) {
              const t = board[tr][tc];
              if (!t) pseudo.push({ from, to: rcToSq(tr, tc), piece: p.type });
              else {
                if (t.color === opp) pseudo.push({ from, to: rcToSq(tr, tc), piece: p.type, captured: t.type });
                break;
              }
              tr += dr; tc += dc;
            }
          }
        }
      }
    }
    return pseudo.filter(m => !inCheck(applyMoveLocal(st, m).board, turn));
  }

  function evalBoardLocal(st) {
    let sc = 0;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = st.board[r][c];
        if (!p) continue;
        const centerBonus = (r >= 2 && r <= 5 && c >= 2 && c <= 5) ? 15 : 0;
        const v = (PIECE_VAL[p.type] || 0) + centerBonus;
        sc += p.color === 'w' ? v : -v;
      }
    }
    return sc;
  }

  function alphaBetaLocal(st, depth, alpha, beta, maxing) {
    const moves = genLegalMovesLocal(st);
    if (!moves.length) {
      if (inCheck(st.board, st.turn)) return maxing ? -90000 - depth * 100 : 90000 + depth * 100;
      return 0;
    }
    if (depth <= 0) return evalBoardLocal(st);
    moves.sort((a, b) => (PIECE_VAL[b.captured] || 0) - (PIECE_VAL[a.captured] || 0));
    if (maxing) {
      let best = -Infinity;
      for (const m of moves) {
        const v = alphaBetaLocal(applyMoveLocal(st, m), depth - 1, alpha, beta, false);
        if (v > best) best = v;
        if (best > alpha) alpha = best;
        if (beta <= alpha) break;
      }
      return best;
    } else {
      let best = Infinity;
      for (const m of moves) {
        const v = alphaBetaLocal(applyMoveLocal(st, m), depth - 1, alpha, beta, true);
        if (v < best) best = v;
        if (best < beta) beta = best;
        if (beta <= alpha) break;
      }
      return best;
    }
  }

  async function computeBestChessMove(fen) {
    // 0. Coba Self-Hosted Dashboard API (http://127.0.0.1:8791/api/chess/analyze) terlebih dahulu
    try {
      const dashBase = (cfg.localDashboardUrl || 'http://127.0.0.1:8791').replace(/\/+$/, '');
      const localRes = await fetch(`${dashBase}/api/chess/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fen, depth: 12, useCloud: !!cfg.chessUseCloud }),
        signal: AbortSignal.timeout(1800),
      });
      if (localRes.ok) {
        const ld = await localRes.json();
        if (ld && ld.ok && ld.bestMove) {
          return {
            source: ld.source || 'DuoVanguard Engine',
            from: ld.bestMove.from,
            to: ld.bestMove.to,
            promotion: ld.bestMove.promotion || 'q',
            san: ld.bestMove.san || `${ld.bestMove.from}→${ld.bestMove.to}`,
            scorePawns: String(ld.scorePawns ?? '0.00'),
            tactic: ld.bestMove.tactic || 'Best Move',
          };
        }
      }
    } catch {}

    // 1. Coba Stockfish Cloud API langsung jika diaktifkan (sangat kuat untuk lawan Oscar / PvP)
    if (cfg.chessUseCloud) {
      try {
        const res = await fetch('https://chess-api.com/v1', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fen, depth: 12 }),
          signal: AbortSignal.timeout(1900),
        });
        if (res.ok) {
          const d = await res.json();
          if (d && d.from && d.to) {
            return {
              source: `Stockfish NNUE (d${d.depth || 12})`,
              from: d.from,
              to: d.to,
              promotion: d.promotion || 'q',
              san: d.san || `${d.from}→${d.to}`,
              scorePawns: Number(d.eval || 0).toFixed(2),
              tactic: d.mate ? `Mate in ${d.mate}!` : (d.text || 'Best Move'),
            };
          }
        }
      } catch {}
    }

    // 2. Fallback instan ke mesin Alpha-Beta lokal
    const st = parseFenLocal(fen);
    if (!st) return null;
    const moves = genLegalMovesLocal(st);
    if (!moves.length) return null;
    const maxing = st.turn === 'w';
    let bestMove = moves[0];
    let bestVal = maxing ? -Infinity : Infinity;
    for (const m of moves) {
      const val = alphaBetaLocal(applyMoveLocal(st, m), 2, -Infinity, Infinity, !maxing);
      if ((maxing && val > bestVal) || (!maxing && val < bestVal)) {
        bestVal = val;
        bestMove = m;
      }
    }
    return {
      source: 'Local Alpha-Beta (d3)',
      from: bestMove.from,
      to: bestMove.to,
      promotion: bestMove.promotion || 'q',
      san: `${bestMove.piece.toUpperCase()}${bestMove.captured ? 'x' : ''}${bestMove.to}`,
      scorePawns: (bestVal / 100).toFixed(2),
      tactic: bestMove.captured ? `Capture ${bestMove.captured.toUpperCase()}` : 'Positional',
    };
  }

  async function forceWinChessViaRedux() {
    try {
      const store = getReduxStore();
      if (!store) return false;
      const player = store.getState()?.player;
      const ch = player?.session?.challenges?.[player.currentIndex];
      const guess = {
        matchState: { status: 'completed', outcome: 'win' },
        gradingState: { type: 'correct' },
      };
      store.dispatch({ type: 'CHALLENGE_GUESS_CHANGE', value: guess });
      store.dispatch({
        type: 'UPDATE_GRADED_CHALLENGE',
        gradingResult: { correct: true, guess },
        skipped: false,
        timeTaken: 1200,
      });
      await sleep(90);
      const nextBtn = document.querySelector('[data-test="player-next"]');
      if (nextBtn && !nextBtn.disabled) nextBtn.click();
      const statusEl = document.getElementById('dh-pro-chess-status');
      if (statusEl) statusEl.textContent = '🏆 Menang Instan dikirim!';
      return true;
    } catch {
      return false;
    }
  }

  // Deteksi elemen papan catur Duolingo di DOM
  function detectChessBoardElement() {
    const selectors = [
      'cg-board',
      '[data-test*="chess-board"]',
      '[data-test*="chessboard"]',
      '[class*="chessboard" i]',
      '[class*="ChessBoard" i]',
      'div[data-board]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.getBoundingClientRect().width >= 180) return el;
    }
    // Cari kontainer persegi (>=220x220) yang memiliki 64 kotak atau buah catur
    const allDivs = document.querySelectorAll('[data-test^="challenge"] div, main div');
    for (const d of allDivs) {
      const r = d.getBoundingClientRect();
      if (r.width >= 220 && r.width <= 720 && Math.abs(r.width - r.height) < 12) {
        if (d.querySelectorAll('[data-square], [class*="square" i], [class*="piece" i]').length >= 8) {
          return d;
        }
      }
    }
    return null;
  }

  // Deteksi FEN & warna pemain dari Redux Store + React Fiber + DOM
  function detectDuolingoChessContext() {
    const fenRegex = /^([rnbqkpRNBQKP1-8]+\/){7}[rnbqkpRNBQKP1-8]+\s+[wb]\s+/;
    let foundFen = null;
    let playerColor = cfg.chessPerspective !== 'auto' ? cfg.chessPerspective : null;
    let moveCallbacks = [];

    // 1. Cek Redux Store (player.chessPvpMatchState.boardFen / player.chessColor / challengeStates)
    try {
      const store = getReduxStore();
      const player = store?.getState?.()?.player;
      if (player) {
        if (!playerColor && player.chessColor) {
          playerColor = String(player.chessColor).toLowerCase().startsWith('b') ? 'b' : 'w';
        }
        if (player.chessPvpMatchState?.boardFen) {
          foundFen = player.chessPvpMatchState.boardFen;
        }
        const curGuess = player.challengeStates?.[player.currentIndex]?.guess;
        if (!foundFen && curGuess) {
          if (typeof curGuess.boardFen === 'string') foundFen = curGuess.boardFen;
          else if (typeof curGuess.fen === 'string') foundFen = curGuess.fen;
          else if (typeof curGuess.matchState?.boardFen === 'string') foundFen = curGuess.matchState.boardFen;
          else if (typeof curGuess.matchState?.fen === 'string') foundFen = curGuess.matchState.fen;
        }
        const curCh = player.session?.challenges?.[player.currentIndex];
        if (!foundFen && curCh) {
          for (const k of ['fen', 'boardFen', 'initialFen', 'puzzleFen', 'startingFen']) {
            if (typeof curCh[k] === 'string' && fenRegex.test(curCh[k])) {
              foundFen = curCh[k];
              break;
            }
          }
        }
      }
    } catch {}

    // 2. Scan React Fiber dari elemen papan catur untuk mencari FEN aktif & handler gerakan
    const boardEl = detectChessBoardElement();
    if (boardEl) {
      let f = getDomFiber(boardEl);
      let steps = 0;
      while (f && steps < 35) {
        steps++;
        const props = f.memoizedProps || f.stateNode?.props || {};
        const state = f.memoizedState || f.stateNode?.state || {};

        for (const obj of [props, state]) {
          if (!obj || typeof obj !== 'object') continue;
          for (const [k, v] of Object.entries(obj)) {
            if (typeof v === 'string' && fenRegex.test(v.trim())) {
              foundFen = v.trim();
            } else if (v && typeof v === 'object') {
              if (typeof v.fen === 'function') {
                try {
                  const fnVal = v.fen();
                  if (typeof fnVal === 'string' && fenRegex.test(fnVal)) foundFen = fnVal;
                } catch {}
              } else if (typeof v.boardFen === 'string' && fenRegex.test(v.boardFen)) {
                foundFen = v.boardFen;
              } else if (typeof v.fen === 'string' && fenRegex.test(v.fen)) {
                foundFen = v.fen;
              }
            }
            if (typeof v === 'function' && /move|drop|square/i.test(k)) {
              moveCallbacks.push({ name: k, fn: v });
            }
          }
        }
        f = f.return;
      }
    }

    if (foundFen && !foundFen.includes(' ')) {
      foundFen += ' w KQkq - 0 1';
    } else if (foundFen && foundFen.split(/\s+/).length === 2) {
      foundFen += ' KQkq - 0 1';
    }

    return {
      boardEl,
      fen: foundFen,
      playerColor: playerColor || 'w',
      moveCallbacks,
    };
  }

  function squareToPixel(boardEl, sq, orientation = 'w') {
    const rect = boardEl.getBoundingClientRect();
    const rc = sqToRc(sq);
    if (!rc) return null;
    const [r, c] = rc;
    const colIdx = orientation === 'b' ? 7 - c : c;
    const rowIdx = orientation === 'b' ? 7 - r : r;
    const sqW = rect.width / 8;
    const sqH = rect.height / 8;
    return {
      x: rect.left + (colIdx + 0.5) * sqW,
      y: rect.top + (rowIdx + 0.5) * sqH,
      relX: (colIdx + 0.5) * sqW,
      relY: (rowIdx + 0.5) * sqH,
      sqW,
      sqH,
    };
  }

  function renderChessArrowOverlay(boardEl, bestMove, orientation = 'w') {
    let svg = document.getElementById('dh-pro-chess-svg-overlay');
    if (!cfg.chessShowArrow || !boardEl || !bestMove) {
      if (svg) svg.remove();
      return;
    }
    const rect = boardEl.getBoundingClientRect();
    if (rect.width < 50) return;

    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'dh-pro-chess-svg-overlay';
      document.body.appendChild(svg);
    }

    svg.setAttribute('width', String(rect.width));
    svg.setAttribute('height', String(rect.height));
    svg.style.cssText = `
      position: fixed;
      left: ${rect.left}px;
      top: ${rect.top}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      pointer-events: none;
      z-index: 999990;
    `;

    const p1 = squareToPixel(boardEl, bestMove.from, orientation);
    const p2 = squareToPixel(boardEl, bestMove.to, orientation);
    if (!p1 || !p2) return;

    svg.innerHTML = `
      <defs>
        <marker id="dh-arrowhead" markerWidth="4.5" markerHeight="4.5" refX="2.8" refY="2.25" orient="auto">
          <polygon points="0 0, 4.5 2.25, 0 4.5" fill="#58cc02" />
        </marker>
      </defs>
      <rect x="${p1.relX - p1.sqW / 2 + 2}" y="${p1.relY - p1.sqH / 2 + 2}" width="${p1.sqW - 4}" height="${p1.sqH - 4}" rx="6" fill="rgba(56, 189, 248, 0.32)" stroke="#38bdf8" stroke-width="3" />
      <rect x="${p2.relX - p2.sqW / 2 + 2}" y="${p2.relY - p2.sqH / 2 + 2}" width="${p2.sqW - 4}" height="${p2.sqH - 4}" rx="6" fill="rgba(88, 204, 2, 0.32)" stroke="#58cc02" stroke-width="3" />
      <line x1="${p1.relX}" y1="${p1.relY}" x2="${p2.relX}" y2="${p2.relY}" stroke="#58cc02" stroke-width="7" stroke-linecap="round" opacity="0.9" marker-end="url(#dh-arrowhead)" />
    `;
  }

  async function executeChessMoveOnDom(ctx, bestMove) {
    if (!bestMove) return false;
    const { boardEl, playerColor, moveCallbacks } = ctx;

    // 1. Coba panggil React callback langsung jika tersedia
    for (const cb of moveCallbacks || []) {
      try {
        if (/drop/i.test(cb.name)) cb.fn(bestMove.from, bestMove.to, 'wQ');
        else if (/square/i.test(cb.name)) { cb.fn(bestMove.from); setTimeout(() => cb.fn(bestMove.to), 60); }
        else cb.fn({ from: bestMove.from, to: bestMove.to, promotion: bestMove.promotion || 'q' });
      } catch {}
    }

    // 2. Cari elemen kotak spesifik berdasarkan data-square / data-test
    const fromSqEl =
      document.querySelector(`[data-square="${bestMove.from}"]`) ||
      document.querySelector(`[data-test*="${bestMove.from}"]`);
    const toSqEl =
      document.querySelector(`[data-square="${bestMove.to}"]`) ||
      document.querySelector(`[data-test*="${bestMove.to}"]`);

    if (fromSqEl && toSqEl) {
      fromSqEl.click();
      await sleep(70);
      toSqEl.click();
    }

    // 3. Simulasi Pointer + Mouse Drag & Click berdasarkan koordinat piksel papan 8x8
    if (boardEl) {
      const p1 = squareToPixel(boardEl, bestMove.from, playerColor);
      const p2 = squareToPixel(boardEl, bestMove.to, playerColor);
      if (p1 && p2) {
        const startTarget = document.elementFromPoint(p1.x, p1.y) || boardEl;
        const fire = (target, type, x, y, buttons = 1) => {
          target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, buttons, isPrimary: true }));
          const mouseType = type.replace('pointer', 'mouse');
          if (['mousedown', 'mousemove', 'mouseup'].includes(mouseType)) {
            target.dispatchEvent(new MouseEvent(mouseType, { bubbles: true, cancelable: true, clientX: x, clientY: y, buttons }));
          }
        };

        // Klik kotak asal lalu kotak tujuan
        fire(startTarget, 'pointerdown', p1.x, p1.y, 1);
        fire(startTarget, 'pointerup', p1.x, p1.y, 0);
        startTarget.click?.();
        await sleep(75);

        const endTarget = document.elementFromPoint(p2.x, p2.y) || boardEl;
        fire(endTarget, 'pointerdown', p2.x, p2.y, 1);
        fire(endTarget, 'pointerup', p2.x, p2.y, 0);
        endTarget.click?.();

        // Sekaligus drag-and-drop halus jika UI memakai drag handler
        await sleep(40);
        fire(startTarget, 'pointerdown', p1.x, p1.y, 1);
        for (let s = 1; s <= 6; s++) {
          const cx = p1.x + ((p2.x - p1.x) * s) / 6;
          const cy = p1.y + ((p2.y - p1.y) * s) / 6;
          fire(document, 'pointermove', cx, cy, 1);
        }
        fire(endTarget, 'pointerup', p2.x, p2.y, 0);
      }
    }

    return true;
  }

  let lastAnalyzedFen = null;
  let lastBestMove = null;
  let lastChessCtx = null;

  async function runChessBotStep(forceMove = false) {
    const ctx = detectDuolingoChessContext();
    lastChessCtx = ctx;
    const statusEl = document.getElementById('dh-pro-chess-status');
    const recEl = document.getElementById('dh-pro-chess-rec');

    const fen = ctx.fen || document.getElementById('dh-pro-chess-fen')?.value?.trim();
    if (!fen) {
      if (statusEl) statusEl.textContent = 'Menunggu papan catur Oscar/PvP...';
      return null;
    }

    const fenInput = document.getElementById('dh-pro-chess-fen');
    if (fenInput && document.activeElement !== fenInput) {
      fenInput.value = fen;
    }

    if (fen !== lastAnalyzedFen || !lastBestMove || forceMove) {
      lastAnalyzedFen = fen;
      if (statusEl) statusEl.textContent = 'Menganalisis langkah terbaik...';
      lastBestMove = await computeBestChessMove(fen);
    }

    if (lastBestMove) {
      if (statusEl) statusEl.textContent = `${lastBestMove.source} • Turn: ${fen.split(' ')[1] === 'b' ? 'Black' : 'White'}`;
      if (recEl) {
        recEl.innerHTML =
          `<span style="color:#58cc02;font-size:15px;font-weight:900;">${lastBestMove.from.toUpperCase()} → ${lastBestMove.to.toUpperCase()}</span> ` +
          `<span style="color:#38bdf8;font-weight:800;">(${lastBestMove.san})</span> • ` +
          `<span style="color:#fbbf24;">Eval ${lastBestMove.scorePawns}</span>`;
      }
      if (ctx.boardEl) {
        renderChessArrowOverlay(ctx.boardEl, lastBestMove, ctx.playerColor);
      }

      const turnCol = fen.split(' ')[1] === 'b' ? 'b' : 'w';
      const isMyTurn = cfg.chessPerspective === 'auto' || turnCol === ctx.playerColor;
      if (forceMove || (cfg.chessAutoPlay && isMyTurn)) {
        await executeChessMoveOnDom(ctx, lastBestMove);
      }
    }
    return lastBestMove;
  }

  // ============================================================================
  // 5. AUDIO MUTING HOOK
  // ============================================================================
  function applyMuteState() {
    document.querySelectorAll('audio, video').forEach(el => {
      el.muted = !!cfg.muteAudio;
      if (cfg.muteAudio) el.volume = 0;
    });
    if (window.Howler && typeof window.Howler.mute === 'function') {
      window.Howler.mute(!!cfg.muteAudio);
    }
  }

  // ============================================================================
  // 6. IN-LESSON SOLVE BUTTONS & FLOATING CONTROL PANEL (WITH CHESS BOT HUD)
  // ============================================================================
  let autoLoopTimer = null;

  function scheduleNextAutoSolve() {
    if (!cfg.autoSolveAll) return;
    const wait = cfg.randomSolveSpeed
      ? Math.floor(250 + Math.random() * Math.max(300, cfg.solveSpeedMs))
      : Math.max(150, Number(cfg.solveSpeedMs) || 450);
    autoLoopTimer = setTimeout(async () => {
      if (!cfg.autoSolveAll) return;
      await solveCurrentQuestion();
      scheduleNextAutoSolve();
    }, wait);
  }

  function toggleAutoSolveAll(forceState) {
    cfg.autoSolveAll = typeof forceState === 'boolean' ? forceState : !cfg.autoSolveAll;
    saveCfg();
    if (autoLoopTimer) clearTimeout(autoLoopTimer);
    if (cfg.autoSolveAll) scheduleNextAutoSolve();
    syncButtonsState();
  }

  function updateOverlayCounter() {
    const el = document.getElementById('dh-pro-solved-counter');
    if (el) el.textContent = String(cfg.solvedCount || 0);
  }

  function syncButtonsState() {
    const solveAllBtn = document.getElementById('dh-pro-btn-solve-all');
    if (solveAllBtn) {
      solveAllBtn.textContent = cfg.autoSolveAll ? '⏸ Pause Auto' : '⚡ Solve All';
      solveAllBtn.style.background = cfg.autoSolveAll ? '#ff4b4b' : '#58cc02';
    }
    const panelAutoBtn = document.getElementById('dh-pro-panel-auto');
    if (panelAutoBtn) {
      panelAutoBtn.textContent = cfg.autoSolveAll ? '⏸ Pause Auto-Solve (Alt+A)' : '▶️ Auto-Solve All (Alt+A)';
      panelAutoBtn.style.background = cfg.autoSolveAll ? '#ff4b4b' : '#38bdf8';
    }
  }

  function injectLessonButtons() {
    const target =
      document.querySelector('[data-test="player-next"]') ||
      document.querySelector('[data-test="stories-player-continue"]') ||
      document.querySelector('[data-test="stories-player-done"]');
    if (!target || !target.parentElement) return;
    if (document.getElementById('dh-pro-btn-solve-one')) return;

    // Sama seperti Duolingo PRO 3.1 addButtons(): pastikan container flex rapi
    const flexContainer = document.querySelector('.MYehf') || document.querySelector('._3TJzR') || target.parentElement;
    if (flexContainer) {
      flexContainer.style.display = 'flex';
      flexContainer.style.gap = '10px';
      flexContainer.style.alignItems = 'center';
    }

    const btnOne = document.createElement('button');
    btnOne.id = 'dh-pro-btn-solve-one';
    btnOne.type = 'button';
    btnOne.textContent = 'SOLVE (Alt+S)';
    btnOne.style.cssText =
      'padding:12px 18px;border-radius:14px;border:none;border-bottom:4px solid #0284c7;' +
      'background:#38bdf8;color:#0f172a;font-weight:900;font-size:13px;cursor:pointer;text-transform:uppercase;letter-spacing:0.5px;';
    btnOne.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      solveCurrentQuestion();
    });

    const btnAll = document.createElement('button');
    btnAll.id = 'dh-pro-btn-solve-all';
    btnAll.type = 'button';
    btnAll.textContent = cfg.autoSolveAll ? '⏸ PAUSE AUTO' : '⚡ SOLVE ALL';
    btnAll.style.cssText =
      'padding:12px 18px;border-radius:14px;border:none;border-bottom:4px solid #46a302;' +
      `background:${cfg.autoSolveAll ? '#ff4b4b' : '#58cc02'};color:#fff;font-weight:900;font-size:13px;cursor:pointer;text-transform:uppercase;letter-spacing:0.5px;`;
    btnAll.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      toggleAutoSolveAll();
    });

    target.parentElement.appendChild(btnOne);
    target.parentElement.appendChild(btnAll);
  }

  function injectFloatingCompanion() {
    if (document.getElementById('dh-pro-companion-root')) return;

    const root = document.createElement('div');
    root.id = 'dh-pro-companion-root';
    root.innerHTML = `
      <style>
        #dh-pro-fab {
          position: fixed; bottom: 22px; right: 22px; z-index: 999998;
          width: 54px; height: 54px; border-radius: 50%;
          background: linear-gradient(135deg, #38bdf8, #58cc02);
          color: #0b0f17; font-weight: 900; font-size: 24px;
          display: flex; align-items: center; justify-content: center;
          box-shadow: 0 8px 25px rgba(56, 189, 248, 0.45);
          cursor: pointer; user-select: none; border: 2px solid rgba(255,255,255,0.4);
          transition: transform 0.2s ease;
        }
        #dh-pro-fab:hover { transform: scale(1.08); }
        #dh-pro-panel {
          position: fixed; bottom: 86px; right: 22px; z-index: 999999;
          width: 340px; background: rgba(15, 23, 42, 0.96);
          backdrop-filter: blur(18px); color: #f8fafc;
          border: 1px solid rgba(56, 189, 248, 0.35);
          border-radius: 18px; padding: 16px;
          box-shadow: 0 20px 50px rgba(0,0,0,0.7);
          font-family: 'Nunito', -apple-system, BlinkMacSystemFont, sans-serif;
          display: none;
        }
        #dh-pro-panel.open { display: block; }
        .dh-row { display: flex; justify-content: space-between; align-items: center; margin: 7px 0; font-size: 12px; font-weight: 800; }
        .dh-btn {
          width: 100%; padding: 9px 12px; border-radius: 10px; border: none;
          font-weight: 900; font-size: 12px; cursor: pointer; margin-top: 6px;
          text-transform: uppercase; letter-spacing: 0.4px;
        }
        .dh-sec {
          margin-top: 10px; padding-top: 10px;
          border-top: 1px solid rgba(255,255,255,0.1);
        }
      </style>
      <div id="dh-pro-fab" title="DuoVanguard Companion v4.2 (Solver + Chess Bot)">🦉</div>
      <div id="dh-pro-panel">
        <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,0.1);padding-bottom:8px;margin-bottom:8px;">
          <div>
            <div style="font-weight:900;font-size:15px;color:#38bdf8;">DuoVanguard v4.2</div>
            <div style="font-size:11px;color:#94a3b8;">Redux + DOM Solver • Chess Bot • Max</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:10px;color:#94a3b8;">SOLVED</div>
            <div id="dh-pro-solved-counter" style="font-size:16px;font-weight:900;color:#58cc02;">${cfg.solvedCount || 0}</div>
          </div>
        </div>

        <div class="dh-row">
          <span>✨ Fake Duolingo Max</span>
          <input type="checkbox" id="dh-pro-chk-max" ${cfg.fakeMax ? 'checked' : ''} />
        </div>
        <div class="dh-row">
          <span>🔇 Mute Lesson Audio</span>
          <input type="checkbox" id="dh-pro-chk-mute" ${cfg.muteAudio ? 'checked' : ''} />
        </div>
        <div class="dh-row">
          <span>⏱ Solve Delay (ms)</span>
          <input type="number" id="dh-pro-inp-speed" value="${cfg.solveSpeedMs}" min="100" max="5000" step="50" style="width:75px;background:#1e293b;color:#fff;border:1px solid #334155;border-radius:6px;padding:4px 6px;text-align:right;font-weight:800;" />
        </div>

        <button class="dh-btn" style="background:#58cc02;color:#052e16;" id="dh-pro-panel-solve">⚡ Solve 1 Soal (Alt+S)</button>
        <button class="dh-btn" style="background:#38bdf8;color:#0f172a;" id="dh-pro-panel-auto">▶️ Auto-Solve All (Alt+A)</button>

        <!-- CHESS BOT VS OSCAR / PVP SECTION -->
        <div class="dh-sec">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <span style="font-weight:900;font-size:13px;color:#fbbf24;">♟️ Chess Bot (Vs Oscar / PvP)</span>
            <span id="dh-pro-chess-status" style="font-size:10px;color:#94a3b8;">Siap</span>
          </div>
          <div id="dh-pro-chess-rec" style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:7px 9px;font-size:12px;margin-bottom:6px;">
            Klik "Analisis / Jalan" saat bertanding catur
          </div>
          <input id="dh-pro-chess-fen" type="text" placeholder="FEN otomatis terdeteksi atau tempel FEN..." style="width:100%;background:#1e293b;color:#cbd5e1;border:1px solid #334155;border-radius:7px;padding:5px 8px;font-size:11px;font-family:monospace;margin-bottom:6px;" />
          <div class="dh-row">
            <span>🤖 Auto-Gerak saat Giliran</span>
            <input type="checkbox" id="dh-pro-chk-chess-auto" ${cfg.chessAutoPlay ? 'checked' : ''} />
          </div>
          <div class="dh-row">
            <span>🎯 Panah Cheat di Papan</span>
            <input type="checkbox" id="dh-pro-chk-chess-arrow" ${cfg.chessShowArrow ? 'checked' : ''} />
          </div>
          <div style="display:flex;gap:6px;">
            <button class="dh-btn" style="background:#fbbf24;color:#451a03;flex:1;" id="dh-pro-chess-hint">🔍 Cari Langkah</button>
            <button class="dh-btn" style="background:#58cc02;color:#052e16;flex:1;" id="dh-pro-chess-move">♟️ Gerakkan!</button>
          </div>
          <button class="dh-btn" style="background:#f97316;color:#431407;" id="dh-pro-chess-win">🏆 Menang Instan (Oscar / Puzzle)</button>
        </div>

        <div class="dh-sec">
          <button class="dh-btn" style="background:#c084fc;color:#2e1065;" id="dh-pro-open-dash">🚀 Buka Self-Hosted Dashboard</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    const fab = document.getElementById('dh-pro-fab');
    const panel = document.getElementById('dh-pro-panel');
    fab.onclick = () => panel.classList.toggle('open');

    document.getElementById('dh-pro-chk-max').onchange = e => {
      cfg.fakeMax = e.target.checked;
      saveCfg();
      alert('Fake Duolingo Max diubah. Refresh halaman Duolingo agar efek penuh terlihat.');
    };
    document.getElementById('dh-pro-chk-mute').onchange = e => {
      cfg.muteAudio = e.target.checked;
      saveCfg();
      applyMuteState();
    };
    document.getElementById('dh-pro-inp-speed').onchange = e => {
      cfg.solveSpeedMs = Math.max(100, Number(e.target.value) || 450);
      saveCfg();
    };
    document.getElementById('dh-pro-panel-solve').onclick = () => solveCurrentQuestion();
    document.getElementById('dh-pro-panel-auto').onclick = () => toggleAutoSolveAll();

    document.getElementById('dh-pro-chk-chess-auto').onchange = e => {
      cfg.chessAutoPlay = e.target.checked;
      saveCfg();
    };
    document.getElementById('dh-pro-chk-chess-arrow').onchange = e => {
      cfg.chessShowArrow = e.target.checked;
      saveCfg();
      if (!cfg.chessShowArrow) {
        document.getElementById('dh-pro-chess-svg-overlay')?.remove();
      }
    };
    document.getElementById('dh-pro-chess-hint').onclick = () => runChessBotStep(false);
    document.getElementById('dh-pro-chess-move').onclick = () => runChessBotStep(true);
    document.getElementById('dh-pro-chess-win').onclick = () => forceWinChessViaRedux();

    document.getElementById('dh-pro-open-dash').onclick = () => {
      window.open(cfg.localDashboardUrl || 'http://127.0.0.1:8791', '_blank');
    };
  }

  window.addEventListener('keydown', e => {
    if (e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      solveCurrentQuestion();
    } else if (e.altKey && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      toggleAutoSolveAll();
    } else if (e.altKey && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      runChessBotStep(true);
    }
  });

  setInterval(() => {
    if (!document.body) return;
    injectFloatingCompanion();
    injectLessonButtons();
    if (cfg.muteAudio) applyMuteState();
    if (cfg.chessAutoPlay || cfg.chessShowArrow) {
      if (detectChessBoardElement()) {
        runChessBotStep(false);
      } else {
        document.getElementById('dh-pro-chess-svg-overlay')?.remove();
      }
    }
  }, 550);
})();
