import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, CartesianGrid, Legend, Cell,
} from "recharts";

/* ============================================================
   EUCHRE ENGINE — pure functions
   ============================================================ */

const SUITS = ["S", "H", "D", "C"];
const SUIT_SYM = { S: "♠", H: "♥", D: "♦", C: "♣" };
const SUIT_NAME = { S: "Spades", H: "Hearts", D: "Diamonds", C: "Clubs" };
const RED = { H: true, D: true };
const SAME_COLOR = { S: "C", C: "S", H: "D", D: "H" };
const RANKS = ["9", "10", "J", "Q", "K", "A"];
const SEAT_POS = ["South", "West", "North", "East"];

const STYLES = {
  conservative: { label: "The Rock", desc: "Tight caller, ducks tricks, saves trump", call: 6.2, loner: 8.7, aggr: 0 },
  balanced: { label: "The Analyst", desc: "By-the-book thresholds, textbook leads", call: 5.4, loner: 8.1, aggr: 1 },
  aggressive: { label: "The Gambler", desc: "Loose caller, leads trump, forces the action", call: 4.6, loner: 7.4, aggr: 2 },
};
const STYLE_KEYS = Object.keys(STYLES);

const rankIdx = (r) => RANKS.indexOf(r);
const isRight = (c, t) => c.rank === "J" && c.suit === t;
const isLeft = (c, t) => c.rank === "J" && c.suit === SAME_COLOR[t];
const effSuit = (c, t) => (isLeft(c, t) ? t : c.suit);
const cardId = (c) => c.rank + c.suit;

function power(c, trump, lead) {
  if (isRight(c, trump)) return 1000;
  if (isLeft(c, trump)) return 999;
  if (effSuit(c, trump) === trump) return 900 + rankIdx(c.rank);
  if (effSuit(c, trump) === lead) return 100 + rankIdx(c.rank);
  return rankIdx(c.rank);
}

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r });
  return d;
}
function shuffle(a) {
  const d = a.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function trickWinner(trick, trump) {
  const lead = effSuit(trick[0].card, trump);
  let best = trick[0];
  for (const p of trick) if (power(p.card, trump, lead) > power(best.card, trump, lead)) best = p;
  return best.seat;
}

/* ---------- hand evaluation for bidding ---------- */
function evalHand(hand, trump) {
  let v = 0;
  const offSuits = new Set();
  for (const c of hand) {
    if (isRight(c, trump)) v += 3.0;
    else if (isLeft(c, trump)) v += 2.6;
    else if (c.suit === trump) {
      v += { A: 2.2, K: 1.9, Q: 1.7, "10": 1.5, "9": 1.4 }[c.rank];
    } else {
      if (c.rank === "A") v += 0.9;
      else if (c.rank === "K") v += 0.25;
      offSuits.add(c.suit);
    }
  }
  // void bonus: fewer off-suits = easier to trump in
  const possibleOff = SUITS.filter((s) => s !== trump).length; // 3
  v += 0.5 * Math.max(0, possibleOff - offSuits.size - 1);
  return v;
}

function bestDiscard(hand, trump) {
  // lowest-value card, never a bower, prefer non-trump
  let worst = null, worstV = Infinity;
  for (const c of hand) {
    let val;
    if (isRight(c, trump) || isLeft(c, trump)) val = 100;
    else if (c.suit === trump) val = 50 + rankIdx(c.rank);
    else val = c.rank === "A" ? 20 : rankIdx(c.rank);
    if (val < worstV) { worstV = val; worst = c; }
  }
  return worst;
}

/* ---------- custom "always call" rule engine ---------- */
// A custom rule lets a seat override normal scoring-based bidding, in one of two modes:
//  - "count": always call the first suit with N+ cards (optionally requiring a bower)
//  - "ranks": always call the first suit where the hand holds every one of a chosen
//             set of ranks (e.g. Left bower + K + 10)
const RANK_OPTIONS = ["right", "left", "A", "K", "Q", "10", "9"];
const RANK_LABEL = { right: "Right", left: "Left", A: "A", K: "K", Q: "Q", "10": "10", "9": "9" };

function suitCount(hand, suit) {
  return hand.filter((c) => effSuit(c, suit) === suit).length;
}
function hasBowerInSuit(hand, suit) {
  return hand.some((c) => isRight(c, suit) || isLeft(c, suit));
}
function hasRankInSuit(hand, suit, rank) {
  if (rank === "right") return hand.some((c) => isRight(c, suit));
  if (rank === "left") return hand.some((c) => isLeft(c, suit));
  return hand.some((c) => c.suit === suit && c.rank === rank);
}
function customRuleFires(hand, suit, rule) {
  if (!rule || !rule.enabled) return false;
  const count = suitCount(hand, suit);
  if (rule.mode === "ranks") {
    const need = rule.ranks || [];
    if (!need.length || !need.every((r) => hasRankInSuit(hand, suit, r))) return false;
    // "exactOnly" means these ranks are the WHOLE trump holding, not just a subset of it
    // (e.g. testing "what if I called with only 9-10", not "9-10 plus whatever else").
    if (rule.exactOnly && count !== need.length) return false;
    return true;
  }
  if (rule.exactOnly ? count !== rule.minCount : count < rule.minCount) return false;
  if (rule.requireBower && !hasBowerInSuit(hand, suit)) return false;
  return true;
}
function ruleDesc(rule) {
  if (!rule || !rule.enabled) return null;
  if (rule.mode === "ranks") {
    const ranks = rule.ranks || [];
    if (!ranks.length) return null;
    const label = ranks.map((r) => RANK_LABEL[r]).join("+");
    return rule.exactOnly ? `Only ${label}` : `Has ${label}`;
  }
  const base = rule.exactOnly ? `Exactly ${rule.minCount}` : `${rule.minCount}+`;
  return `${base} ${rule.requireBower ? "(needs bower)" : "(no bower needed)"}`;
}

/* ---------- hand-strength classification, for post-hoc stats ---------- */
// The highest-value trump asset a hand holds, in euchre power order.
function trumpProfile(hand, trump) {
  if (hand.some((c) => isRight(c, trump))) return "right";
  if (hand.some((c) => isLeft(c, trump))) return "left";
  const ranks = hand.filter((c) => c.suit === trump).map((c) => c.rank);
  for (const r of ["A", "K", "Q", "10", "9"]) if (ranks.includes(r)) return r;
  return "none";
}
const TRUMP_CAP_ORDER = ["right", "left", "A", "K", "Q", "10", "9", "none"];
const TRUMP_CAP_LABEL = {
  right: "Right bower", left: "Left bower", A: "Ace-high", K: "King-high",
  Q: "Queen-high", "10": "10-high", "9": "9-high", none: "No trump",
};

/* ---------- how trump got called ---------- */
const CALL_TYPE_ORDER = ["pickup", "orderedPartner", "orderedOpponent", "named", "stuck"];
const CALL_TYPE_LABEL = {
  pickup: "Picked it up (own upcard)",
  orderedPartner: "Ordered up partner",
  orderedOpponent: "Ordered up opponent",
  named: "Named trump (turned down)",
  stuck: "Stuck the dealer (forced)",
};
function classifyCallType(round, maker, dealer, forced) {
  if (round === 1) {
    if (maker === dealer) return "pickup";
    return maker % 2 === dealer % 2 ? "orderedPartner" : "orderedOpponent";
  }
  return forced ? "stuck" : "named";
}

/* Round 1 bid: order the upcard's suit as trump? */
function botBidR1(hand, upcard, seat, dealer, style, customRule) {
  const trump = upcard.suit;
  let pickupHand = hand;
  if (seat === dealer) {
    const h = hand.concat([upcard]);
    const disc = bestDiscard(h, trump);
    pickupHand = h.filter((c) => c !== disc);
  }
  if (customRuleFires(pickupHand, trump, customRule)) {
    return { call: true, alone: !!customRule.goAlone && hasBowerInSuit(pickupHand, trump), customFired: true };
  }
  let score;
  if (seat === dealer) {
    score = evalHand(pickupHand, trump) + 0.3;
  } else {
    score = evalHand(hand, trump);
    const upVal = upcard.rank === "J" ? 2.4 : { A: 1.6, K: 1.2, Q: 1.0, "10": 0.8, "9": 0.7 }[upcard.rank];
    const dealerIsPartner = (dealer % 2) === (seat % 2);
    score += dealerIsPartner ? upVal * 0.35 : -upVal * 0.45;
  }
  const cfg = STYLES[style];
  if (score >= cfg.call) return { call: true, alone: score >= cfg.loner };
  return { call: false };
}

/* Round 2 bid: name any suit except the turned-down one */
function botBidR2(hand, turnedSuit, seat, dealer, style, stickDealer, customRule) {
  if (customRule && customRule.enabled) {
    let bestSuit = null, bestCount = -1;
    for (const s of SUITS) {
      if (s === turnedSuit) continue;
      if (customRuleFires(hand, s, customRule)) {
        const c = suitCount(hand, s);
        if (c > bestCount) { bestCount = c; bestSuit = s; }
      }
    }
    if (bestSuit) {
      return { suit: bestSuit, alone: !!customRule.goAlone && hasBowerInSuit(hand, bestSuit), customFired: true, forced: false };
    }
  }
  const cfg = STYLES[style];
  let best = null, bestScore = -1;
  for (const s of SUITS) {
    if (s === turnedSuit) continue;
    const sc = evalHand(hand, s);
    if (sc > bestScore) { bestScore = sc; best = s; }
  }
  const stuck = stickDealer && seat === dealer;
  const meetsScore = bestScore >= cfg.call - 0.3;
  if (meetsScore || stuck) {
    // "forced" = the only reason this call happened is stick-the-dealer, not that the hand qualified on its own
    return { suit: best, alone: bestScore >= cfg.loner, forced: stuck && !meetsScore };
  }
  return { suit: null };
}

/* ---------- card play ---------- */
function legalMoves(hand, trick, trump) {
  if (trick.length === 0) return hand.slice();
  const lead = effSuit(trick[0].card, trump);
  const follow = hand.filter((c) => effSuit(c, trump) === lead);
  return follow.length ? follow : hand.slice();
}

function discardValue(c, trump) {
  if (isRight(c, trump)) return 100;
  if (isLeft(c, trump)) return 95;
  if (c.suit === trump) return 60 + rankIdx(c.rank);
  return (c.rank === "A" ? 15 : rankIdx(c.rank));
}

function chooseCard(hand, trick, trump, seat, maker, style, playedCards) {
  const legal = legalMoves(hand, trick, trump);
  if (legal.length === 1) return legal[0];
  const cfg = STYLES[style];
  const onMakers = (seat % 2) === (maker % 2);

  if (trick.length === 0) {
    // Leading
    const trumps = legal.filter((c) => effSuit(c, trump) === trump)
      .sort((a, b) => power(b, trump, null) - power(a, trump, null));
    const offAces = legal.filter((c) => effSuit(c, trump) !== trump && c.rank === "A");
    const rightHeld = trumps.length && isRight(trumps[0], trump);

    if (onMakers) {
      if (rightHeld && (cfg.aggr >= 1 || trumps.length >= 3)) return trumps[0];
      if (cfg.aggr === 2 && trumps.length >= 2) return trumps[0];
      if (offAces.length) return offAces[0];
      if (trumps.length >= 3) return trumps[0];
    } else {
      if (offAces.length) return offAces[0];
      if (cfg.aggr === 2 && rightHeld) return trumps[0];
    }
    // default: lead lowest off-suit (conservative) or highest off (aggressive)
    const off = legal.filter((c) => effSuit(c, trump) !== trump);
    const pool = off.length ? off : legal;
    pool.sort((a, b) => discardValue(a, trump) - discardValue(b, trump));
    return cfg.aggr === 2 ? pool[pool.length - 1] : pool[0];
  }

  // Following
  const lead = effSuit(trick[0].card, trump);
  let winSeat = trickWinner(trick, trump);
  const winCard = trick.find((p) => p.seat === winSeat).card;
  const winPower = power(winCard, trump, lead);
  const partnerWinning = winSeat % 2 === seat % 2;
  const lastToAct = trick.length === 3; // 4-handed; close enough 3-handed

  const winners = legal.filter((c) => {
    const p = power(c, trump, lead);
    // if I can't follow suit, only trump beats; power() handles this since lead suit fixed
    return p > winPower && (effSuit(c, trump) === lead || effSuit(c, trump) === trump);
  }).sort((a, b) => power(a, trump, lead) - power(b, trump, lead));

  const lowest = legal.slice().sort((a, b) => discardValue(a, trump) - discardValue(b, trump))[0];

  if (partnerWinning) {
    const partnerStrong = winPower >= 900 || (effSuit(winCard, trump) === lead && winCard.rank === "A");
    if (lastToAct || partnerStrong || cfg.aggr === 0) return lowest;
    // aggressive/balanced may still take over a weak partner card
    if (winners.length && winPower < 105) return winners[0];
    return lowest;
  }

  if (winners.length) {
    if (lastToAct) return winners[0]; // cheapest winner seals it
    return cfg.aggr === 2 ? winners[winners.length - 1] : winners[0];
  }
  return lowest;
}

/* ---------- full-hand runner (used by simulation) ---------- */
function runBidding(hands, upcard, dealer, styles, stickDealer, customRules) {
  // returns { trump, maker, alone, round, ruleFired, ruleDesc } or null (all pass, no stick)
  for (let i = 1; i <= 4; i++) {
    const seat = (dealer + i) % 4;
    const r = botBidR1(hands[seat], upcard, seat, dealer, styles[seat], customRules?.[seat]);
    if (r.call) {
      return {
        trump: upcard.suit, maker: seat, alone: r.alone, round: 1,
        ruleFired: !!r.customFired, ruleDesc: r.customFired ? ruleDesc(customRules[seat]) : null,
      };
    }
  }
  for (let i = 1; i <= 4; i++) {
    const seat = (dealer + i) % 4;
    const r = botBidR2(hands[seat], upcard.suit, seat, dealer, styles[seat], stickDealer, customRules?.[seat]);
    if (r.suit) {
      return {
        trump: r.suit, maker: seat, alone: r.alone, round: 2,
        ruleFired: !!r.customFired, ruleDesc: r.customFired ? ruleDesc(customRules[seat]) : null,
        forced: !!r.forced,
      };
    }
  }
  return null;
}

function simulateHand(dealer, styles, stickDealer, customRules) {
  const deck = shuffle(makeDeck());
  const hands = [0, 1, 2, 3].map((i) => deck.slice(i * 5, i * 5 + 5));
  const upcard = deck[20];
  const bid = runBidding(hands, upcard, dealer, styles, stickDealer, customRules);
  if (!bid) return null; // redeal

  const { trump, maker, alone, round, ruleFired, ruleDesc: rDesc, forced } = bid;
  const sitter = alone ? (maker + 2) % 4 : null;
  const callerScore = evalHand(hands[maker], trump);
  const callType = classifyCallType(round, maker, dealer, forced);

  // dealer picks up on round 1 (if playing)
  if (round === 1 && sitter !== dealer) {
    hands[dealer] = hands[dealer].concat([upcard]);
    const disc = bestDiscard(hands[dealer], trump);
    hands[dealer] = hands[dealer].filter((c) => c !== disc);
  }

  const trumpCap = trumpProfile(hands[maker], trump);

  let leader = (dealer + 1) % 4;
  if (leader === sitter) leader = (dealer + 2) % 4;
  const trickCount = [0, 0]; // team 0 = seats 0/2, team 1 = seats 1/3
  const played = [];

  for (let t = 0; t < 5; t++) {
    const trick = [];
    let seat = leader;
    const n = sitter === null ? 4 : 3;
    let placed = 0;
    while (placed < n) {
      if (seat !== sitter) {
        const card = chooseCard(hands[seat], trick, trump, seat, maker, styles[seat], played);
        hands[seat] = hands[seat].filter((c) => c !== card);
        trick.push({ seat, card });
        played.push(card);
        placed++;
      }
      seat = (seat + 1) % 4;
    }
    leader = trickWinner(trick, trump);
    trickCount[leader % 2]++;
  }

  const makerTeam = maker % 2;
  const mTricks = trickCount[makerTeam];
  let pts, winTeam, euchred = false;
  if (mTricks >= 3) {
    winTeam = makerTeam;
    pts = mTricks === 5 ? (alone ? 4 : 2) : 1;
  } else {
    winTeam = 1 - makerTeam;
    pts = 2;
    euchred = true;
  }

  return {
    dealer, caller: maker, callerStyle: styles[maker], callerTeam: makerTeam,
    trump, round, alone, upcard: cardId(upcard),
    tricksMaker: mTricks, pts, winTeam, euchred,
    sweep: mTricks === 5, callerEval: Math.round(callerScore * 10) / 10,
    trumpCap, ruleFired: !!ruleFired, ruleDesc: rDesc || null, callType,
  };
}

function simulateGames(targetHands, styles, stickDealer, customRules) {
  const records = [];
  let game = 1, dealer = Math.floor(Math.random() * 4);
  let score = [0, 0], handNum = 0, guard = 0;
  while (records.length < targetHands && guard < targetHands * 4) {
    guard++;
    const r = simulateHand(dealer, styles, stickDealer, customRules);
    dealer = (dealer + 1) % 4;
    if (!r) continue;
    handNum++;
    score[r.winTeam] += r.pts;
    records.push({ ...r, n: handNum, game, src: "sim" });
    if (score[0] >= 10 || score[1] >= 10) { game++; score = [0, 0]; }
  }
  return records;
}

/* ============================================================
   UI HELPERS
   ============================================================ */

function sortHand(hand, trump) {
  const suitRank = (c) => {
    const s = effSuit(c, trump || "X");
    if (trump && s === trump) return -1;
    return SUITS.indexOf(s);
  };
  return hand.slice().sort((a, b) => {
    const d = suitRank(a) - suitRank(b);
    if (d !== 0) return d;
    return power(b, trump || "S", null) - power(a, trump || "S", null);
  });
}

const PlayingCard = ({ card, onClick, disabled, small, faceDown, highlight }) => {
  if (faceDown) {
    return <div className={`pcard back ${small ? "small" : ""}`} />;
  }
  const red = RED[card.suit];
  return (
    <button
      className={`pcard ${small ? "small" : ""} ${red ? "red" : "black"} ${disabled ? "dim" : ""} ${highlight ? "hl" : ""}`}
      onClick={onClick}
      disabled={disabled || !onClick}
    >
      <span className="rank">{card.rank}</span>
      <span className="suit">{SUIT_SYM[card.suit]}</span>
    </button>
  );
};

const TrumpBadge = ({ trump, maker, alone, styles }) =>
  trump ? (
    <div className="trump-badge">
      <span className={`tb-suit ${RED[trump] ? "red" : ""}`}>{SUIT_SYM[trump]}</span>
      <span className="tb-text">
        {SUIT_NAME[trump]} · called by {SEAT_POS[maker]}
        {alone ? " · ALONE" : ""}
      </span>
    </div>
  ) : null;

/* ============================================================
   MAIN COMPONENT
   ============================================================ */

export default function EuchreLab() {
  const [tab, setTab] = useState("play");
  const [records, setRecords] = useState([]);
  const [styles, setStyles] = useState(["balanced", "aggressive", "balanced", "conservative"]);
  const [customRules, setCustomRules] = useState(
    [0, 1, 2, 3].map(() => ({
      enabled: false, mode: "count", minCount: 3, requireBower: true, ranks: [], exactOnly: false, goAlone: false,
    }))
  );
  const updateCustomRule = (seat, patch) =>
    setCustomRules((arr) => arr.map((r, i) => (i === seat ? { ...r, ...patch } : r)));
  const [stickDealer, setStickDealer] = useState(true);
  const [allowRenege, setAllowRenege] = useState(false);
  const [simCount, setSimCount] = useState(1000);
  const [simRunning, setSimRunning] = useState(false);
  const [simDone, setSimDone] = useState(0);
  const simCancelRef = useRef(false);
  useEffect(() => () => { simCancelRef.current = true; }, []);
  const [callTypeFilter, setCallTypeFilter] = useState("all");

  /* ---------------- interactive game state ---------------- */
  const [g, setG] = useState(null);
  const handCounter = useRef(0);
  const gameCounter = useRef(0);

  const newDeal = useCallback((score, dealer, gameNum) => {
    const deck = shuffle(makeDeck());
    return {
      score, gameNum,
      dealer,
      hands: [0, 1, 2, 3].map((i) => deck.slice(i * 5, i * 5 + 5)),
      upcard: deck[20],
      phase: "bid1",
      turn: (dealer + 1) % 4,
      trump: null, maker: null, alone: false, round: null, sitter: null,
      trick: [], leader: null, trickNum: 0, trickCount: [0, 0],
      msg: `${SEAT_POS[(dealer + 1) % 4]} bids first. Dealer: ${SEAT_POS[dealer]}.`,
      lastResult: null,
      played: [],
      ruleFired: false, ruleDesc: null, trumpCap: null, callType: null,
    };
  }, []);

  const startNewGame = useCallback(() => {
    gameCounter.current += 1;
    setG(newDeal([0, 0], Math.floor(Math.random() * 4), gameCounter.current));
  }, [newDeal]);

  useEffect(() => { if (!g && tab === "play") startNewGame(); }, [tab, g, startNewGame]);

  const beginPlay = (st) => {
    let leader = (st.dealer + 1) % 4;
    if (leader === st.sitter) leader = (st.dealer + 2) % 4;
    return {
      ...st, phase: "play", leader, turn: leader, trick: [],
      msg: `${SUIT_NAME[st.trump]} are trump. ${SEAT_POS[leader]} leads.`,
    };
  };

  const applyCall = (st, seat, trump, alone, round, customFired = false, rule = null, forced = false) => {
    const sitter = alone ? (seat + 2) % 4 : null;
    const callType = classifyCallType(round, seat, st.dealer, forced);
    let next = {
      ...st, trump, maker: seat, alone, round, sitter, callType,
      ruleFired: !!customFired, ruleDesc: customFired ? ruleDesc(rule) : null,
    };
    if (round === 1 && sitter !== st.dealer) {
      const hands = next.hands.map((h) => h.slice());
      hands[st.dealer] = hands[st.dealer].concat([st.upcard]);
      next = { ...next, hands };
      if (st.dealer === 0) {
        return { ...next, phase: "discard", turn: 0, msg: "You picked it up — choose a card to discard." };
      }
      const disc = bestDiscard(hands[st.dealer], trump);
      hands[st.dealer] = hands[st.dealer].filter((c) => c !== disc);
      next = { ...next, hands, trumpCap: trumpProfile(hands[seat], trump) };
    } else {
      next = { ...next, trumpCap: trumpProfile(next.hands[seat], trump) };
    }
    return beginPlay(next);
  };

  const scoreHand = (st) => {
    const makerTeam = st.maker % 2;
    const mTricks = st.trickCount[makerTeam];
    let pts, winTeam, euchred = false;
    if (mTricks >= 3) { winTeam = makerTeam; pts = mTricks === 5 ? (st.alone ? 4 : 2) : 1; }
    else { winTeam = 1 - makerTeam; pts = 2; euchred = true; }

    handCounter.current += 1;
    const rec = {
      n: handCounter.current, game: st.gameNum, src: "play",
      dealer: st.dealer, caller: st.maker, callerStyle: st.maker === 0 ? "human" : styles[st.maker],
      callerTeam: makerTeam, trump: st.trump, round: st.round, alone: st.alone,
      upcard: cardId(st.upcard), tricksMaker: mTricks, pts, winTeam, euchred,
      sweep: mTricks === 5, callerEval: null,
      trumpCap: st.trumpCap, ruleFired: !!st.ruleFired, ruleDesc: st.ruleDesc || null, callType: st.callType,
    };
    setRecords((r) => [...r, rec]);

    const score = st.score.slice();
    score[winTeam] += pts;
    const over = score[0] >= 10 || score[1] >= 10;
    const resultTxt = euchred
      ? `EUCHRED! ${SEAT_POS[st.maker]}'s call goes down — ${pts} pts to ${winTeam === 0 ? "your team" : "opponents"}.`
      : `${SEAT_POS[st.maker]} makes it${mTricks === 5 ? " — SWEEP" : ""}${st.alone && mTricks === 5 ? " ALONE (4 pts!)" : ""}. ${pts} pt${pts > 1 ? "s" : ""}.`;

    return {
      ...st, score, phase: over ? "gameOver" : "handEnd",
      msg: over ? `${resultTxt}  Game over — ${score[0] >= 10 ? "YOUR TEAM WINS" : "OPPONENTS WIN"} ${score[0]}–${score[1]}.` : resultTxt,
      lastResult: rec,
    };
  };

  // Reneging (failing to follow suit when able) is always caught instantly and costs
  // the offender's team 2 points, ending the hand right there — no trick play involved.
  const scoreRenege = (st, seat) => {
    const winTeam = 1 - (seat % 2);
    const pts = 2;

    handCounter.current += 1;
    const rec = {
      n: handCounter.current, game: st.gameNum, src: "play",
      dealer: st.dealer, caller: st.maker, callerStyle: st.maker === 0 ? "human" : styles[st.maker],
      callerTeam: st.maker % 2, trump: st.trump, round: st.round, alone: st.alone,
      upcard: cardId(st.upcard), tricksMaker: st.trickCount[st.maker % 2], pts, winTeam, euchred: false,
      sweep: false, callerEval: null,
      trumpCap: st.trumpCap, ruleFired: !!st.ruleFired, ruleDesc: st.ruleDesc || null, callType: st.callType,
      renege: true,
    };
    setRecords((r) => [...r, rec]);

    const score = st.score.slice();
    score[winTeam] += pts;
    const over = score[0] >= 10 || score[1] >= 10;
    const resultTxt = `RENEGE! ${SEAT_POS[seat]} failed to follow suit and got caught — ${pts} pts to ${winTeam === 0 ? "your team" : "opponents"}.`;

    return {
      ...st, score, phase: over ? "gameOver" : "handEnd",
      msg: over ? `${resultTxt}  Game over — ${score[0] >= 10 ? "YOUR TEAM WINS" : "OPPONENTS WIN"} ${score[0]}–${score[1]}.` : resultTxt,
      lastResult: rec,
    };
  };

  const playCardTo = (st, seat, card) => {
    const hands = st.hands.map((h) => h.slice());
    hands[seat] = hands[seat].filter((c) => c !== card);
    const trick = [...st.trick, { seat, card }];
    const need = st.sitter === null ? 4 : 3;
    let next = { ...st, hands, trick, played: [...st.played, card] };
    if (trick.length === need) return { ...next, phase: "trickPause" };
    let t = (seat + 1) % 4;
    if (t === st.sitter) t = (t + 1) % 4;
    return { ...next, turn: t };
  };

  const resolveTrick = (st) => {
    const w = trickWinner(st.trick, st.trump);
    const tc = st.trickCount.slice();
    tc[w % 2]++;
    const trickNum = st.trickNum + 1;
    let next = { ...st, trickCount: tc, trickNum, trick: [], leader: w, turn: w, msg: `${SEAT_POS[w]} takes the trick.` };
    if (trickNum === 5) return scoreHand(next);
    return { ...next, phase: "play" };
  };

  /* bot driver */
  useEffect(() => {
    if (!g || tab !== "play") return;
    const t = setTimeout(() => {
      setG((st) => {
        if (!st) return st;
        if (st.phase === "trickPause") return resolveTrick(st);
        if (st.phase === "bid1" && st.turn !== 0) {
          const r = botBidR1(st.hands[st.turn], st.upcard, st.turn, st.dealer, styles[st.turn], customRules[st.turn]);
          if (r.call) return applyCall(st, st.turn, st.upcard.suit, r.alone, 1, r.customFired, customRules[st.turn]);
          if (st.turn === st.dealer) return { ...st, phase: "bid2", turn: (st.dealer + 1) % 4, msg: `Everyone passed. ${SUIT_SYM[st.upcard.suit]} is turned down — name a suit.` };
          return { ...st, turn: (st.turn + 1) % 4, msg: `${SEAT_POS[st.turn]} passes.` };
        }
        if (st.phase === "bid2" && st.turn !== 0) {
          const r = botBidR2(st.hands[st.turn], st.upcard.suit, st.turn, st.dealer, styles[st.turn], stickDealer, customRules[st.turn]);
          if (r.suit) return applyCall(st, st.turn, r.suit, r.alone, 2, r.customFired, customRules[st.turn], r.forced);
          if (st.turn === st.dealer) {
            gameCounter.current = st.gameNum;
            return { ...newDeal(st.score, (st.dealer + 1) % 4, st.gameNum), msg: "All passed — redeal." };
          }
          return { ...st, turn: (st.turn + 1) % 4, msg: `${SEAT_POS[st.turn]} passes.` };
        }
        if (st.phase === "play" && st.turn !== 0) {
          const card = chooseCard(st.hands[st.turn], st.trick, st.trump, st.turn, st.maker, styles[st.turn], st.played);
          return playCardTo(st, st.turn, card);
        }
        return st;
      });
    }, g.phase === "trickPause" ? 950 : 620);
    return () => clearTimeout(t);
  }, [g, tab, styles, stickDealer, newDeal, customRules]);

  /* human actions */
  const humanBid1 = (call, alone) => setG((st) => {
    if (call) return applyCall(st, 0, st.upcard.suit, alone, 1);
    if (st.dealer === 0) return { ...st, phase: "bid2", turn: (st.dealer + 1) % 4, msg: `Turned down. Round 2 — name a suit.` };
    return { ...st, turn: (st.turn + 1) % 4, msg: "You pass." };
  });
  const humanBid2 = (suit, alone) => setG((st) => {
    if (suit) return applyCall(st, 0, suit, alone, 2, false, null, st.dealer === 0 && stickDealer);
    if (st.dealer === 0) {
      if (stickDealer) return st; // UI prevents this
      gameCounter.current = st.gameNum;
      return { ...newDeal(st.score, (st.dealer + 1) % 4, st.gameNum), msg: "All passed — redeal." };
    }
    return { ...st, turn: (st.turn + 1) % 4, msg: "You pass." };
  });
  const humanDiscard = (card) => setG((st) => {
    const hands = st.hands.map((h) => h.slice());
    hands[0] = hands[0].filter((c) => c !== card);
    const trumpCap = trumpProfile(hands[st.maker], st.trump);
    return beginPlay({ ...st, hands, trumpCap });
  });
  const humanPlay = (card) => setG((st) => {
    if (st.phase !== "play" || st.turn !== 0) return st;
    const legal = legalMoves(st.hands[0], st.trick, st.trump);
    if (!legal.includes(card)) {
      if (!allowRenege) return st;
      return scoreRenege(st, 0);
    }
    return playCardTo(st, 0, card);
  });
  const nextHand = () => setG((st) => {
    gameCounter.current = st.gameNum;
    return newDeal(st.score, (st.dealer + 1) % 4, st.gameNum);
  });

  /* ---------------- simulation ---------------- */
  // Runs in small async chunks (instead of one blocking call) so a progress bar can
  // update and the tab stays responsive, however many hands are requested.
  const runSim = () => {
    setSimRunning(true);
    setSimDone(0);
    simCancelRef.current = false;
    const total = simCount;
    const collected = [];
    let done = 0;
    let chunkSize = 300;

    const finish = () => {
      setRecords((r) => [...r, ...collected]);
      setSimRunning(false);
      setTab("stats");
    };

    const step = () => {
      if (simCancelRef.current) { finish(); return; }
      const target = Math.min(chunkSize, total - done);
      const t0 = performance.now();
      const recs = simulateGames(target, styles, stickDealer, customRules);
      const elapsed = performance.now() - t0;
      collected.push(...recs);
      done += Math.max(recs.length, 1); // guard against a pathological all-redeal chunk stalling progress
      setSimDone(Math.min(done, total));
      if (elapsed > 0) chunkSize = Math.max(100, Math.round((chunkSize * 40) / elapsed));
      if (done < total) setTimeout(step, 0);
      else finish();
    };
    setTimeout(step, 20);
  };

  const cancelSim = () => { simCancelRef.current = true; };

  /* ---------------- stats ---------------- */
  const stats = useMemo(() => {
    if (!records.length) return null;
    const filteredRecords = callTypeFilter === "all"
      ? records
      : records.filter((r) => r.callType === callTypeFilter);

    // "how trump got called" breakdown always reflects the full dataset, regardless of
    // the filter above, so you can see the whole distribution while narrowed to one slice.
    const byCallType = {};
    for (const r of records) {
      if (!r.callType) continue;
      if (!byCallType[r.callType]) byCallType[r.callType] = { calls: 0, ptsFor: 0, ptsAgainst: 0, euchres: 0, sweeps: 0 };
      const c = byCallType[r.callType];
      c.calls++;
      if (r.euchred) { c.euchres++; c.ptsAgainst += r.pts; } else { c.ptsFor += r.pts; if (r.sweep) c.sweeps++; }
    }
    const callTypeRows = CALL_TYPE_ORDER.filter((k) => byCallType[k]).map((k) => {
      const c = byCallType[k];
      return {
        type: CALL_TYPE_LABEL[k], calls: c.calls,
        makeRate: +(((c.calls - c.euchres) / c.calls) * 100).toFixed(1),
        netPerCall: +((c.ptsFor - c.ptsAgainst) / c.calls).toFixed(3),
        euchreRate: +((c.euchres / c.calls) * 100).toFixed(1),
      };
    });

    if (!filteredRecords.length) {
      return { total: 0, grandTotal: records.length, callTypeRows, empty: true };
    }

    const byStyle = {};
    const bySeat = [0, 1, 2, 3].map(() => ({ calls: 0, pts: 0, euchres: 0 }));
    const bySuit = { S: 0, H: 0, D: 0, C: 0 };
    const outcomes = { "Made (1)": 0, "Sweep (2)": 0, "Alone sweep (4)": 0, "Euchred": 0 };
    const byRule = {};
    const byCap = {};
    let lonerAttempts = 0, lonerMade = 0, r1 = 0, r2 = 0;

    for (const r of filteredRecords) {
      const key = r.callerStyle;
      if (!byStyle[key]) byStyle[key] = { calls: 0, ptsFor: 0, ptsAgainst: 0, euchres: 0, sweeps: 0, loners: 0, lonersMade: 0 };
      const s = byStyle[key];
      s.calls++;
      if (r.euchred) { s.euchres++; s.ptsAgainst += r.pts; } else { s.ptsFor += r.pts; if (r.sweep) s.sweeps++; }
      if (r.alone) { s.loners++; lonerAttempts++; if (r.sweep && !r.euchred) { s.lonersMade++; lonerMade++; } }
      bySeat[r.caller].calls++;
      if (!r.euchred) bySeat[r.caller].pts += r.pts; else bySeat[r.caller].euchres++;
      bySuit[r.trump]++;
      if (r.round === 1) r1++; else r2++;
      if (r.euchred) outcomes["Euchred"]++;
      else if (r.alone && r.sweep) outcomes["Alone sweep (4)"]++;
      else if (r.sweep) outcomes["Sweep (2)"]++;
      else outcomes["Made (1)"]++;

      if (r.ruleFired && r.ruleDesc) {
        if (!byRule[r.ruleDesc]) byRule[r.ruleDesc] = { calls: 0, ptsFor: 0, ptsAgainst: 0, euchres: 0, sweeps: 0 };
        const b = byRule[r.ruleDesc];
        b.calls++;
        if (r.euchred) { b.euchres++; b.ptsAgainst += r.pts; } else { b.ptsFor += r.pts; if (r.sweep) b.sweeps++; }
      }
      if (r.trumpCap) {
        if (!byCap[r.trumpCap]) byCap[r.trumpCap] = { calls: 0, ptsFor: 0, ptsAgainst: 0, euchres: 0, sweeps: 0 };
        const c = byCap[r.trumpCap];
        c.calls++;
        if (r.euchred) { c.euchres++; c.ptsAgainst += r.pts; } else { c.ptsFor += r.pts; if (r.sweep) c.sweeps++; }
      }
    }

    const styleRows = Object.entries(byStyle).map(([k, s]) => ({
      styleName: k === "human" ? "You" : STYLES[k]?.label || k,
      calls: s.calls,
      netPerCall: +((s.ptsFor - s.ptsAgainst) / s.calls).toFixed(3),
      euchreRate: +((s.euchres / s.calls) * 100).toFixed(1),
      sweepRate: +((s.sweeps / s.calls) * 100).toFixed(1),
      loners: s.loners, lonersMade: s.lonersMade,
    }));

    const ruleRows = Object.entries(byRule).map(([k, b]) => ({
      rule: k, calls: b.calls,
      makeRate: +(((b.calls - b.euchres) / b.calls) * 100).toFixed(1),
      netPerCall: +((b.ptsFor - b.ptsAgainst) / b.calls).toFixed(3),
      euchreRate: +((b.euchres / b.calls) * 100).toFixed(1),
      sweepRate: +((b.sweeps / b.calls) * 100).toFixed(1),
    }));

    const capRows = TRUMP_CAP_ORDER.filter((k) => byCap[k]).map((k) => {
      const b = byCap[k];
      return {
        cap: TRUMP_CAP_LABEL[k], calls: b.calls,
        makeRate: +(((b.calls - b.euchres) / b.calls) * 100).toFixed(1),
        netPerCall: +((b.ptsFor - b.ptsAgainst) / b.calls).toFixed(3),
        euchreRate: +((b.euchres / b.calls) * 100).toFixed(1),
      };
    });

    // rolling maker-make rate (window 25)
    const W = 25, trend = [];
    for (let i = W; i <= filteredRecords.length; i += Math.max(1, Math.floor(W / 2))) {
      const win = filteredRecords.slice(i - W, i);
      const made = win.filter((r) => !r.euchred).length;
      trend.push({ hand: i, makeRate: +((made / W) * 100).toFixed(1) });
    }

    return {
      total: filteredRecords.length, grandTotal: records.length, r1, r2,
      euchreRate: ((filteredRecords.filter((r) => r.euchred).length / filteredRecords.length) * 100).toFixed(1),
      lonerAttempts, lonerMade,
      styleRows, ruleRows, capRows, callTypeRows,
      suitData: SUITS.map((s) => ({ suit: SUIT_NAME[s], count: bySuit[s] })),
      outcomeData: Object.entries(outcomes).map(([k, v]) => ({ outcome: k, count: v })),
      seatData: bySeat.map((s, i) => ({ seat: SEAT_POS[i], calls: s.calls, euchres: s.euchres })),
      trend,
    };
  }, [records, callTypeFilter]);

  const exportCSV = () => {
    const cols = ["n", "src", "game", "dealer", "caller", "callerStyle", "callerTeam", "trump", "round", "alone", "upcard", "tricksMaker", "pts", "winTeam", "euchred", "sweep", "callerEval", "trumpCap", "ruleFired", "ruleDesc", "callType", "renege"];
    const lines = [cols.join(",")];
    for (const r of records) lines.push(cols.map((c) => r[c] ?? "").join(","));
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "euchre_hands.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  /* ---------------- render ---------------- */
  const styleSelect = (seat) => (
    <select
      value={styles[seat]}
      onChange={(e) => setStyles((s) => s.map((v, i) => (i === seat ? e.target.value : v)))}
    >
      {STYLE_KEYS.map((k) => <option key={k} value={k}>{STYLES[k].label}</option>)}
    </select>
  );

  const seatLabel = (seat) => {
    if (seat === 0 && tab === "play") return "You";
    return `${SEAT_POS[seat]} · ${STYLES[styles[seat]].label}`;
  };

  const customRuleControls = (seat) => {
    const rule = customRules[seat];
    const toggleRank = (r) => {
      const has = (rule.ranks || []).includes(r);
      const ranks = has ? rule.ranks.filter((x) => x !== r) : [...(rule.ranks || []), r];
      updateCustomRule(seat, { ranks });
    };
    return (
      <span className="custom-rule-block">
        <label className="chk mini">
          <input
            type="checkbox"
            checked={rule.enabled}
            onChange={(e) => updateCustomRule(seat, { enabled: e.target.checked })}
          />
          Custom call rule
        </label>
        {rule.enabled && (
          <span className="rule-fields">
            <select value={rule.mode} onChange={(e) => updateCustomRule(seat, { mode: e.target.value })}>
              <option value="count">Count threshold</option>
              <option value="ranks">Specific ranks</option>
            </select>

            {rule.mode === "count" ? (
              <>
                <select value={rule.minCount} onChange={(e) => updateCustomRule(seat, { minCount: +e.target.value })}>
                  {[2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} of a suit</option>)}
                </select>
                <label className="chk mini">
                  <input
                    type="checkbox"
                    checked={rule.requireBower}
                    onChange={(e) => updateCustomRule(seat, { requireBower: e.target.checked })}
                  />
                  needs a bower
                </label>
                <label className="chk mini">
                  <input
                    type="checkbox"
                    checked={rule.exactOnly}
                    onChange={(e) => updateCustomRule(seat, { exactOnly: e.target.checked })}
                  />
                  exactly {rule.minCount} (not {rule.minCount}+)
                </label>
                <span className="rule-note">
                  Always calls the first suit with {rule.exactOnly ? "exactly" : "at least"} {rule.minCount} card{rule.minCount === 1 ? "" : "s"}
                  {rule.requireBower ? ", but only if it includes a bower" : " — even with no bower"}.
                </span>
              </>
            ) : (
              <>
                <span className="rank-grid">
                  {RANK_OPTIONS.map((r) => (
                    <label key={r} className="chk mini rank-chip">
                      <input type="checkbox" checked={(rule.ranks || []).includes(r)} onChange={() => toggleRank(r)} />
                      {RANK_LABEL[r]}
                    </label>
                  ))}
                </span>
                <label className="chk mini">
                  <input
                    type="checkbox"
                    checked={rule.exactOnly}
                    onChange={(e) => updateCustomRule(seat, { exactOnly: e.target.checked })}
                  />
                  only these — no other trump cards
                </label>
                <span className="rule-note">
                  {(rule.ranks || []).length
                    ? rule.exactOnly
                      ? `Calls the first suit where the hand's ENTIRE trump holding is exactly: ${rule.ranks.map((r) => RANK_LABEL[r]).join(", ")} (nothing else).`
                      : `Calls the first suit where the hand holds at least: ${rule.ranks.map((r) => RANK_LABEL[r]).join(", ")} — extra trump cards are fine.`
                    : "Pick at least one rank above."}
                </span>
              </>
            )}

            <label className="chk mini">
              <input
                type="checkbox"
                checked={rule.goAlone}
                onChange={(e) => updateCustomRule(seat, { goAlone: e.target.checked })}
              />
              alone
            </label>
            <span className="rule-note">Falls back to the style above when the rule doesn't fire.</span>
          </span>
        )}
      </span>
    );
  };

  const renderTable = () => {
    if (!g) return null;
    const trickCard = (seat) => {
      const p = g.trick.find((x) => x.seat === seat);
      return p ? <PlayingCard card={p.card} small /> : <div className="slot" />;
    };
    const isDealer = (s) => g.dealer === s;
    const isTurn = (s) => (g.phase === "bid1" || g.phase === "bid2" || g.phase === "play") && g.turn === s;
    const sitting = (s) => g.sitter === s;

    const seatTag = (s) => (
      <div className={`seat-tag ${isTurn(s) ? "turn" : ""} ${sitting(s) ? "sit" : ""}`}>
        {seatLabel(s)} {isDealer(s) && <span className="dealer-chip">D</span>}
        {sitting(s) && <span className="sit-chip">sitting</span>}
      </div>
    );

    const myHand = sortHand(g.hands[0], g.trump);
    const myLegal = g.phase === "play" && g.turn === 0 ? legalMoves(g.hands[0], g.trick, g.trump) : [];
    const humanBidding1 = g.phase === "bid1" && g.turn === 0;
    const humanBidding2 = g.phase === "bid2" && g.turn === 0;
    const stuck = humanBidding2 && g.dealer === 0 && stickDealer;

    return (
      <div className="table-wrap">
        <div className="scoreboard">
          <div className="score-team you"><span>You + North</span><b>{g.score[0]}</b></div>
          <div className="score-mid">first to 10</div>
          <div className="score-team opp"><span>West + East</span><b>{g.score[1]}</b></div>
        </div>

        <div className="felt">
          <div className="row north">{seatTag(2)}<div className="bot-cards">{g.hands[2].map((c, i) => <PlayingCard key={i} faceDown small card={c} />)}</div></div>
          <div className="mid-row">
            <div className="side west">{seatTag(1)}<div className="bot-cards vert">{g.hands[1].map((c, i) => <PlayingCard key={i} faceDown small card={c} />)}</div></div>
            <div className="center">
              <TrumpBadge trump={g.trump} maker={g.maker} alone={g.alone} styles={styles} />
              {!g.trump && g.upcard && (g.phase === "bid1") && (
                <div className="upcard-zone"><span className="upcard-label">Upcard</span><PlayingCard card={g.upcard} /></div>
              )}
              {(g.phase === "bid2") && (
                <div className="upcard-zone"><span className="upcard-label">Turned down</span><PlayingCard card={g.upcard} disabled /></div>
              )}
              <div className="trick-grid">
                <div className="tg n">{trickCard(2)}</div>
                <div className="tg w">{trickCard(1)}</div>
                <div className="tg e">{trickCard(3)}</div>
                <div className="tg s">{trickCard(0)}</div>
              </div>
              {g.trump && <div className="trick-tally">Tricks — You: {g.trickCount[0]} · Them: {g.trickCount[1]}</div>}
            </div>
            <div className="side east">{seatTag(3)}<div className="bot-cards vert">{g.hands[3].map((c, i) => <PlayingCard key={i} faceDown small card={c} />)}</div></div>
          </div>
          <div className="row south">
            {seatTag(0)}
            <div className="my-hand">
              {myHand.map((c) => (
                <PlayingCard
                  key={cardId(c)}
                  card={c}
                  onClick={
                    g.phase === "discard" ? () => humanDiscard(c)
                    : g.phase === "play" && g.turn === 0 ? () => humanPlay(c)
                    : undefined
                  }
                  disabled={g.phase === "play" && g.turn === 0 && !allowRenege && !myLegal.includes(c)}
                  highlight={(g.phase === "play" && g.turn === 0 && (allowRenege || myLegal.includes(c))) || g.phase === "discard"}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="msg-bar">{g.msg}</div>

        {humanBidding1 && (
          <div className="action-bar">
            <button className="btn primary" onClick={() => humanBid1(true, false)}>{g.dealer === 0 ? "Pick it up" : "Order it up"}</button>
            <button className="btn alone" onClick={() => humanBid1(true, true)}>Go alone</button>
            <button className="btn" onClick={() => humanBid1(false)}>Pass</button>
          </div>
        )}
        {humanBidding2 && (
          <div className="action-bar">
            {SUITS.filter((s) => s !== g.upcard.suit).map((s) => (
              <span key={s} className="suit-call">
                <button className={`btn suit ${RED[s] ? "reds" : ""}`} onClick={() => humanBid2(s, false)}>{SUIT_SYM[s]} {SUIT_NAME[s]}</button>
                <button className="btn mini" onClick={() => humanBid2(s, true)}>alone</button>
              </span>
            ))}
            {!stuck && <button className="btn" onClick={() => humanBid2(null)}>Pass</button>}
            {stuck && <span className="stuck-note">Stick the dealer — you must call.</span>}
          </div>
        )}
        {g.phase === "handEnd" && <div className="action-bar"><button className="btn primary" onClick={nextHand}>Deal next hand</button></div>}
        {g.phase === "gameOver" && <div className="action-bar"><button className="btn primary" onClick={startNewGame}>New game</button></div>}
      </div>
    );
  };

  const renderSim = () => (
    <div className="panel">
      <h2>Batch simulation</h2>
      <p className="sub">All four seats play as bots. Every hand is logged to the same dataset as your live games (source column tells them apart).</p>
      <div className="sim-grid">
        {[0, 1, 2, 3].map((s) => (
          <div key={s} className="sim-seat">
            <div className="sim-seat-name">{SEAT_POS[s]} {s % 2 === 0 ? "· Team A" : "· Team B"}</div>
            {styleSelect(s)}
            <div className="style-desc">{STYLES[styles[s]].desc}</div>
            {customRuleControls(s)}
          </div>
        ))}
      </div>
      <div className="sim-controls">
        <label>Hands to simulate
          <input type="number" min="50" value={simCount}
            onChange={(e) => setSimCount(Math.max(50, +e.target.value || 0))} disabled={simRunning} />
        </label>
        <label className="chk">
          <input type="checkbox" checked={stickDealer} onChange={(e) => setStickDealer(e.target.checked)} disabled={simRunning} />
          Stick the dealer
        </label>
        <button className="btn primary big" onClick={runSim} disabled={simRunning}>
          {simRunning ? "Dealing…" : `Run ${simCount.toLocaleString()} hands`}
        </button>
        {simRunning && <button className="btn danger" onClick={cancelSim}>Cancel</button>}
      </div>
      {simRunning && (
        <div className="sim-progress-wrap">
          <div className="sim-progress-bar">
            <div className="sim-progress-fill" style={{ width: `${Math.min(100, (simDone / simCount) * 100)}%` }} />
          </div>
          <div className="sim-progress-text">
            {simDone.toLocaleString()} / {simCount.toLocaleString()} hands ({Math.min(100, Math.round((simDone / simCount) * 100))}%)
          </div>
        </div>
      )}
    </div>
  );

  const COLORS = ["#c9a24b", "#7fae8f", "#b3564a", "#5b7a99", "#8b6f9e"];

  const callTypeFilterSelect = (
    <label className="chk">
      How trump was called
      <select value={callTypeFilter} onChange={(e) => setCallTypeFilter(e.target.value)}>
        <option value="all">Any</option>
        {CALL_TYPE_ORDER.map((k) => <option key={k} value={k}>{CALL_TYPE_LABEL[k]}</option>)}
      </select>
    </label>
  );

  const callTypeTable = (rows) => (
    <>
      <h3>Outcomes by how trump was called</h3>
      <p className="sub">
        Always shows every hand logged, regardless of the filter above — use it to compare "picked it up" vs.
        "ordered up partner" vs. "ordered up opponent" vs. a free round-2 call vs. being stuck as dealer.
      </p>
      <table className="data-table">
        <thead><tr><th>Call type</th><th>Calls</th><th>Make %</th><th>Net pts / call</th><th>Euchred %</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.type}>
              <td>{r.type}</td><td>{r.calls}</td><td>{r.makeRate}%</td>
              <td className={r.netPerCall >= 0 ? "pos" : "neg"}>{r.netPerCall > 0 ? "+" : ""}{r.netPerCall}</td>
              <td>{r.euchreRate}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );

  const renderStats = () => {
    if (!stats) return <div className="panel"><h2>No data yet</h2><p className="sub">Play some hands or run a simulation, then come back here.</p></div>;
    if (stats.empty) {
      return (
        <div className="panel">
          <div className="filter-row">{callTypeFilterSelect}</div>
          <h2>No hands match that filter</h2>
          <p className="sub">0 of {stats.grandTotal.toLocaleString()} logged hands were called that way. Try "Any", or a different call type.</p>
          {callTypeTable(stats.callTypeRows)}
        </div>
      );
    }
    return (
      <div className="panel">
        <div className="filter-row">
          {callTypeFilterSelect}
          {callTypeFilter !== "all" && (
            <span className="filter-note">Showing {stats.total.toLocaleString()} of {stats.grandTotal.toLocaleString()} logged hands.</span>
          )}
        </div>

        <div className="stat-strip">
          <div className="stat"><b>{stats.total.toLocaleString()}</b><span>hands logged</span></div>
          <div className="stat"><b>{stats.euchreRate}%</b><span>euchre rate</span></div>
          <div className="stat"><b>{stats.r1} / {stats.r2}</b><span>R1 / R2 calls</span></div>
          <div className="stat"><b>{stats.lonerMade}/{stats.lonerAttempts}</b><span>loners made</span></div>
          <button className="btn" onClick={exportCSV}>Export CSV</button>
          <button className="btn danger" onClick={() => setRecords([])}>Clear data</button>
        </div>

        <h3>Play style scorecard (as caller)</h3>
        <table className="data-table">
          <thead><tr><th>Style</th><th>Calls</th><th>Net pts / call</th><th>Euchred %</th><th>Sweep %</th><th>Loners (made)</th></tr></thead>
          <tbody>
            {stats.styleRows.map((r) => (
              <tr key={r.styleName}>
                <td>{r.styleName}</td><td>{r.calls}</td>
                <td className={r.netPerCall >= 0 ? "pos" : "neg"}>{r.netPerCall > 0 ? "+" : ""}{r.netPerCall}</td>
                <td>{r.euchreRate}%</td><td>{r.sweepRate}%</td><td>{r.loners} ({r.lonersMade})</td>
              </tr>
            ))}
          </tbody>
        </table>

        {stats.ruleRows.length > 0 && (
          <>
            <h3>Custom call-rule performance</h3>
            <p className="sub">
              Only hands where a seat's "custom call rule" actually fired the call (as opposed to falling back to its
              base style). <b>Make %</b> is the share of those calls where the caller took 3+ tricks and avoided a
              euchre — it's just 100% − Euchred %, shown directly so you don't have to do the subtraction. <b>Sweep
              %</b> (all 5 tricks) is a subset of Make %, not additional to it. <b>Net pts/call</b> is the average
              scoreboard swing per call: euchres count against the caller's team, so a positive number means the rule
              pays off over time even after euchre losses are factored in.
            </p>
            <table className="data-table">
              <thead><tr><th>Rule</th><th>Calls</th><th>Make %</th><th>Sweep %</th><th>Euchred %</th><th>Net pts / call</th></tr></thead>
              <tbody>
                {stats.ruleRows.map((r) => (
                  <tr key={r.rule}>
                    <td>{r.rule}</td><td>{r.calls}</td>
                    <td className="pos">{r.makeRate}%</td>
                    <td>{r.sweepRate}%</td>
                    <td className="neg">{r.euchreRate}%</td>
                    <td className={r.netPerCall >= 0 ? "pos" : "neg"}>{r.netPerCall > 0 ? "+" : ""}{r.netPerCall}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <h3>Outcomes by caller's best trump card</h3>
        <p className="sub">
          "No trump higher than an ace" = No bowers row and below. "No trump higher than a king" = King-high row and below.
        </p>
        <table className="data-table">
          <thead><tr><th>Caller held</th><th>Calls</th><th>Make %</th><th>Net pts / call</th><th>Euchred %</th></tr></thead>
          <tbody>
            {stats.capRows.map((r) => (
              <tr key={r.cap}>
                <td>{r.cap}</td><td>{r.calls}</td><td>{r.makeRate}%</td>
                <td className={r.netPerCall >= 0 ? "pos" : "neg"}>{r.netPerCall > 0 ? "+" : ""}{r.netPerCall}</td>
                <td>{r.euchreRate}%</td>
              </tr>
            ))}
          </tbody>
        </table>

        {callTypeTable(stats.callTypeRows)}

        <div className="chart-row">
          <div className="chart-box">
            <h3>Net points per call, by style</h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={stats.styleRows}>
                <CartesianGrid strokeDasharray="3 3" stroke="#3a4a42" />
                <XAxis dataKey="styleName" tick={{ fill: "#cfc8b8", fontSize: 12 }} />
                <YAxis tick={{ fill: "#cfc8b8", fontSize: 12 }} />
                <Tooltip contentStyle={{ background: "#1d2a24", border: "1px solid #3a4a42", color: "#f0ead8" }} />
                <Bar dataKey="netPerCall" name="Net pts/call">
                  {stats.styleRows.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="chart-box">
            <h3>Euchred % by style</h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={stats.styleRows}>
                <CartesianGrid strokeDasharray="3 3" stroke="#3a4a42" />
                <XAxis dataKey="styleName" tick={{ fill: "#cfc8b8", fontSize: 12 }} />
                <YAxis tick={{ fill: "#cfc8b8", fontSize: 12 }} />
                <Tooltip contentStyle={{ background: "#1d2a24", border: "1px solid #3a4a42", color: "#f0ead8" }} />
                <Bar dataKey="euchreRate" name="Euchred %" fill="#b3564a" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="chart-row">
          <div className="chart-box">
            <h3>Trump suit frequency</h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={stats.suitData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#3a4a42" />
                <XAxis dataKey="suit" tick={{ fill: "#cfc8b8", fontSize: 12 }} />
                <YAxis tick={{ fill: "#cfc8b8", fontSize: 12 }} />
                <Tooltip contentStyle={{ background: "#1d2a24", border: "1px solid #3a4a42", color: "#f0ead8" }} />
                <Bar dataKey="count" fill="#c9a24b" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="chart-box">
            <h3>Hand outcomes</h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={stats.outcomeData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#3a4a42" />
                <XAxis dataKey="outcome" tick={{ fill: "#cfc8b8", fontSize: 11 }} />
                <YAxis tick={{ fill: "#cfc8b8", fontSize: 12 }} />
                <Tooltip contentStyle={{ background: "#1d2a24", border: "1px solid #3a4a42", color: "#f0ead8" }} />
                <Bar dataKey="count" fill="#7fae8f" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {stats.trend.length > 1 && (
          <div className="chart-box full">
            <h3>Maker make-rate trend (rolling 25 hands)</h3>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={stats.trend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#3a4a42" />
                <XAxis dataKey="hand" tick={{ fill: "#cfc8b8", fontSize: 12 }} />
                <YAxis domain={[40, 100]} tick={{ fill: "#cfc8b8", fontSize: 12 }} />
                <Tooltip contentStyle={{ background: "#1d2a24", border: "1px solid #3a4a42", color: "#f0ead8" }} />
                <Line type="monotone" dataKey="makeRate" stroke="#c9a24b" dot={false} strokeWidth={2} name="Make rate %" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    );
  };

  const renderLog = () => (
    <div className="panel">
      <div className="stat-strip">
        <div className="stat"><b>{records.length.toLocaleString()}</b><span>rows</span></div>
        <button className="btn" onClick={exportCSV} disabled={!records.length}>Export CSV</button>
      </div>
      {!records.length ? <p className="sub">Nothing logged yet.</p> : (
        <div className="log-scroll">
          <table className="data-table mono">
            <thead><tr><th>#</th><th>Src</th><th>Game</th><th>Dealer</th><th>Caller</th><th>Style</th><th>Trump</th><th>Rd</th><th>Alone</th><th>Up</th><th>Tricks</th><th>Pts</th><th>Result</th><th>Call type</th><th>Caller's top trump</th><th>Rule</th></tr></thead>
            <tbody>
              {records.slice(-300).reverse().map((r) => (
                <tr key={r.src + r.n}>
                  <td>{r.n}</td><td>{r.src}</td><td>{r.game}</td>
                  <td>{SEAT_POS[r.dealer][0]}</td><td>{SEAT_POS[r.caller][0]}</td>
                  <td>{r.callerStyle === "human" ? "You" : STYLES[r.callerStyle]?.label}</td>
                  <td className={RED[r.trump] ? "redtxt" : ""}>{SUIT_SYM[r.trump]}</td>
                  <td>{r.round}</td><td>{r.alone ? "★" : ""}</td><td>{r.upcard}</td>
                  <td>{r.tricksMaker}/5</td><td>{r.pts}</td>
                  <td className={r.euchred || r.renege ? "neg" : "pos"}>{r.renege ? "Reneged" : r.euchred ? "Euchred" : r.sweep ? "Sweep" : "Made"}</td>
                  <td>{r.callType ? CALL_TYPE_LABEL[r.callType] : ""}</td>
                  <td>{r.trumpCap ? TRUMP_CAP_LABEL[r.trumpCap] : ""}</td>
                  <td>{r.ruleFired ? r.ruleDesc : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {records.length > 300 && <p className="sub">Showing latest 300 — export CSV for the full set.</p>}
        </div>
      )}
    </div>
  );

  return (
    <div className="euchre-lab">
      <style>{CSS}</style>
      <header>
        <h1>Euchre Lab</h1>
        <nav>
          {["play", "simulate", "stats", "log"].map((t) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {{ play: "Play", simulate: "Simulate", stats: "Stats", log: "Hand Log" }[t]}
            </button>
          ))}
        </nav>
      </header>

      {tab === "play" && (
        <>
          <div className="table-settings">
            <span className="seat-setting">West: {styleSelect(1)} {customRuleControls(1)}</span>
            <span className="seat-setting">North (partner): {styleSelect(2)} {customRuleControls(2)}</span>
            <span className="seat-setting">East: {styleSelect(3)} {customRuleControls(3)}</span>
            <label className="chk"><input type="checkbox" checked={stickDealer} onChange={(e) => setStickDealer(e.target.checked)} /> Stick the dealer</label>
            <label className="chk">
              <input type="checkbox" checked={allowRenege} onChange={(e) => setAllowRenege(e.target.checked)} />
              Allow reneging
            </label>
            {allowRenege && (
              <span className="rule-note">
                Illegal cards aren't blocked or dimmed — play one and it's caught instantly for 2 pts to the other team.
              </span>
            )}
          </div>
          {renderTable()}
        </>
      )}
      {tab === "simulate" && renderSim()}
      {tab === "stats" && renderStats()}
      {tab === "log" && renderLog()}
    </div>
  );
}

/* ============================================================
   STYLES
   ============================================================ */
const CSS = `
.euchre-lab { min-height: 100vh; background: #14201b; color: #f0ead8; font-family: Georgia, 'Times New Roman', serif; padding: 0 0 40px; }
.euchre-lab header { display:flex; align-items:baseline; gap:24px; padding: 18px 26px 12px; border-bottom: 1px solid #2c3b33; flex-wrap: wrap; }
.euchre-lab h1 { margin:0; font-size: 26px; letter-spacing: 3px; text-transform: uppercase; color:#c9a24b; font-weight: 600; }
.euchre-lab nav { display:flex; gap:6px; }
.euchre-lab nav button { background:none; border:1px solid transparent; color:#cfc8b8; font-family:inherit; font-size:14px; padding:6px 14px; cursor:pointer; border-radius:4px; }
.euchre-lab nav button.on { border-color:#c9a24b; color:#c9a24b; }
.euchre-lab nav button:hover { color:#f0ead8; }

.table-settings { display:flex; gap:18px; padding: 10px 26px; font-size:13px; color:#cfc8b8; flex-wrap:wrap; align-items:center; max-width: 900px; margin: 0 auto; box-sizing: border-box; }
.table-settings select, .sim-seat select { background:#1d2a24; color:#f0ead8; border:1px solid #3a4a42; border-radius:4px; padding:3px 6px; font-family:inherit; }
.seat-setting { display:inline-flex; align-items:center; gap:8px; flex-wrap:wrap; }
.chk { display:flex; align-items:center; gap:6px; cursor:pointer; }
.chk.mini { font-size:12px; gap:4px; }
.custom-rule-block { display:inline-flex; align-items:center; gap:8px; flex-wrap:wrap; background:rgba(0,0,0,.2); border:1px solid #3a4a42; border-radius:6px; padding:4px 8px; }
.rule-fields { display:inline-flex; align-items:center; gap:8px; flex-wrap:wrap; }
.rule-fields select { background:#1d2a24; color:#f0ead8; border:1px solid #3a4a42; border-radius:4px; padding:2px 5px; font-family:inherit; font-size:12px; }
.rule-note { font-size:11px; color:#9aa89f; font-style:italic; max-width:220px; }
.rank-grid { display:inline-flex; gap:6px; flex-wrap:wrap; }
.rank-chip { background:#14201b; border:1px solid #3a4a42; border-radius:10px; padding:2px 8px; }

.table-wrap { width: 900px; max-width: 100%; margin: 8px auto 0; padding: 0 16px; box-sizing: border-box; }
.scoreboard { display:flex; align-items:center; justify-content:center; gap:18px; margin: 8px 0; }
.score-team { display:flex; flex-direction:column; align-items:center; padding:6px 18px; border-radius:6px; background:#1d2a24; border:1px solid #3a4a42; }
.score-team span { font-size:11px; text-transform:uppercase; letter-spacing:1px; color:#cfc8b8; }
.score-team b { font-size:24px; color:#c9a24b; }
.score-mid { font-size:11px; color:#7a8a80; text-transform:uppercase; letter-spacing:1px; }

.felt { background: radial-gradient(ellipse at center, #2f6047 0%, #234a37 70%, #1c3a2c 100%); border: 10px solid #5a3f28; border-radius: 26px; box-shadow: inset 0 0 40px rgba(0,0,0,.45), 0 6px 20px rgba(0,0,0,.5); padding: 14px 16px 18px; }
.row { display:flex; flex-direction:column; align-items:center; gap:6px; }
.mid-row { display:flex; justify-content:space-between; align-items:center; margin: 8px 0; gap: 8px; }
.side { display:flex; flex-direction:column; align-items:center; gap:6px; width: 120px; }
.center { flex:1; display:flex; flex-direction:column; align-items:center; gap:8px; min-height: 230px; justify-content:center; }

.seat-tag { font-size:12px; letter-spacing:.5px; background:rgba(0,0,0,.3); padding:3px 10px; border-radius:12px; border:1px solid transparent; display:flex; gap:6px; align-items:center; }
.seat-tag.turn { border-color:#c9a24b; color:#c9a24b; }
.seat-tag.sit { opacity:.45; }
.dealer-chip { background:#c9a24b; color:#14201b; border-radius:50%; width:16px; height:16px; display:inline-flex; align-items:center; justify-content:center; font-size:10px; font-weight:bold; }
.sit-chip { font-size:10px; font-style:italic; }

.pcard { width: 52px; height: 74px; border-radius: 6px; background: #faf6ec; border: 1px solid #b8ac90; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:0; font-family: Georgia, serif; cursor: default; box-shadow: 0 2px 4px rgba(0,0,0,.35); position:relative; padding:0; }
.pcard .rank { font-size: 18px; font-weight: bold; line-height:1; }
.pcard .suit { font-size: 22px; line-height:1; }
.pcard.red { color: #b3382f; } .pcard.black { color: #1c2321; }
.pcard.small { width: 36px; height: 52px; } .pcard.small .rank { font-size:13px; } .pcard.small .suit { font-size:15px; }
.pcard.back { background: repeating-linear-gradient(45deg, #7a2e28, #7a2e28 4px, #8f3831 4px, #8f3831 8px); border-color:#5a201c; }
.pcard.dim { opacity: .35; }
.pcard.hl { cursor: pointer; }
.pcard.hl:hover { transform: translateY(-8px); box-shadow: 0 8px 14px rgba(0,0,0,.5); transition: transform .12s; }
button.pcard { -webkit-appearance:none; }

.bot-cards { display:flex; gap:3px; }
.bot-cards.vert { flex-direction:column; gap:2px; }
.bot-cards.vert .pcard { height: 30px; width: 44px; }

.upcard-zone { display:flex; align-items:center; gap:10px; }
.upcard-label { font-size:11px; text-transform:uppercase; letter-spacing:2px; color:#cfe3d5; }
.trump-badge { display:flex; align-items:center; gap:8px; background:rgba(0,0,0,.35); padding:5px 14px; border-radius:16px; border:1px solid #c9a24b; }
.tb-suit { font-size:20px; color:#f0ead8; } .tb-suit.red { color:#e0736a; }
.tb-text { font-size:12px; letter-spacing:.5px; }

.trick-grid { display:grid; grid-template-areas: ". n ." "w . e" ". s ."; gap: 4px; }
.tg.n { grid-area:n; } .tg.s { grid-area:s; } .tg.w { grid-area:w; } .tg.e { grid-area:e; }
.slot { width:36px; height:52px; border:1px dashed rgba(255,255,255,.2); border-radius:6px; }
.trick-tally { font-size:12px; color:#cfe3d5; letter-spacing:.5px; }

.my-hand { display:flex; gap:8px; padding-top:4px; flex-wrap:wrap; justify-content:center; }

.msg-bar { text-align:center; margin: 12px auto 4px; font-size: 15px; color:#f0ead8; min-height: 22px; font-style: italic; }
.action-bar { display:flex; justify-content:center; gap:10px; margin: 10px 0; flex-wrap:wrap; align-items:center; }
.btn { background:#1d2a24; border:1px solid #3a4a42; color:#f0ead8; font-family:inherit; font-size:14px; padding:8px 18px; border-radius:6px; cursor:pointer; }
.btn:hover { border-color:#c9a24b; }
.btn.primary { background:#c9a24b; color:#14201b; border-color:#c9a24b; font-weight:bold; }
.btn.alone { border-color:#b3564a; color:#e0736a; }
.btn.suit { font-size:15px; } .btn.suit.reds { color:#e0736a; }
.btn.mini { padding: 4px 8px; font-size:11px; margin-left:2px; }
.btn.big { padding: 12px 28px; font-size:16px; }
.btn.danger { border-color:#b3564a; color:#e0736a; }
.btn:disabled { opacity:.5; cursor:default; }
.suit-call { display:flex; align-items:center; }
.stuck-note { font-size:13px; color:#e0736a; font-style:italic; }

.panel { max-width: 980px; margin: 20px auto; padding: 0 20px; }
.panel h2 { color:#c9a24b; letter-spacing:1px; margin-bottom:4px; }
.panel h3 { color:#cfe3d5; font-size:15px; letter-spacing:1px; text-transform:uppercase; margin: 22px 0 8px; }
.sub { color:#9aa89f; font-size:14px; margin-top:2px; }

.sim-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap:12px; margin: 18px 0; }
.sim-seat { background:#1d2a24; border:1px solid #3a4a42; border-radius:8px; padding:12px; display:flex; flex-direction:column; gap:8px; }
.sim-seat-name { font-size:13px; color:#c9a24b; letter-spacing:1px; }
.style-desc { font-size:12px; color:#9aa89f; font-style:italic; }
.sim-controls { display:flex; gap:20px; align-items:center; flex-wrap:wrap; }
.sim-controls label { display:flex; flex-direction:column; gap:4px; font-size:13px; color:#cfc8b8; }
.sim-controls input[type=number] { background:#1d2a24; color:#f0ead8; border:1px solid #3a4a42; border-radius:4px; padding:6px 8px; width:110px; font-family:inherit; }
.sim-controls .chk { flex-direction:row; }

.sim-progress-wrap { margin-top:16px; }
.sim-progress-bar { height:10px; border-radius:5px; background:#1d2a24; border:1px solid #3a4a42; overflow:hidden; }
.sim-progress-fill { height:100%; background: linear-gradient(90deg, #c9a24b, #7fae8f); transition: width .12s linear; }
.sim-progress-text { margin-top:6px; font-size:12px; color:#9aa89f; letter-spacing:.5px; }

.filter-row { display:flex; gap:16px; align-items:center; flex-wrap:wrap; margin: 16px 0 0; font-size:13px; color:#cfc8b8; }
.filter-row select { background:#1d2a24; color:#f0ead8; border:1px solid #3a4a42; border-radius:4px; padding:4px 8px; margin-left:8px; font-family:inherit; }
.filter-note { font-size:12px; color:#9aa89f; font-style:italic; }
.stat-strip { display:flex; gap:16px; align-items:center; flex-wrap:wrap; margin: 16px 0; }
.stat { background:#1d2a24; border:1px solid #3a4a42; border-radius:8px; padding:8px 16px; display:flex; flex-direction:column; align-items:center; }
.stat b { font-size:20px; color:#c9a24b; } .stat span { font-size:11px; color:#9aa89f; text-transform:uppercase; letter-spacing:1px; }

.data-table { width:100%; border-collapse: collapse; font-size:13px; }
.data-table th { text-align:left; color:#9aa89f; font-weight:normal; text-transform:uppercase; font-size:11px; letter-spacing:1px; padding: 6px 10px; border-bottom:1px solid #3a4a42; }
.data-table td { padding: 6px 10px; border-bottom: 1px solid #26332c; }
.data-table.mono { font-family: 'Courier New', monospace; font-size:12px; }
.pos { color:#7fae8f; } .neg { color:#e0736a; } .redtxt { color:#e0736a; }

.chart-row { display:grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.chart-box { background:#1d2a24; border:1px solid #3a4a42; border-radius:8px; padding: 10px 14px 6px; margin-bottom:16px; }
.chart-box.full { grid-column: 1 / -1; }
.chart-box h3 { margin-top: 4px; }

.log-scroll { max-height: 520px; overflow-y: auto; border:1px solid #3a4a42; border-radius:8px; }

@media (max-width: 720px) {
  .chart-row { grid-template-columns: 1fr; }
  .side { width: 70px; }
  .bot-cards.vert .pcard { width: 34px; }
  .pcard { width: 44px; height: 64px; }
}
`;
