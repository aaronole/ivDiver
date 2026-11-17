const fs = require("fs");
const vm = require("vm");

// --------------------------------------------------
// Usage: node single_analyzer.js <pokeA> <metaListFile.json | ALL> [outFile.json]
//   (ALL = every Pokemon in the live rankings-1500 data)
//
//   pokeA          species id, optionally "species.FAST_MOVE" (same syntax
//                  as matchup_analyzer.js)
//   metaListFile   JSON array of species ids (same optional ".FAST_MOVE")
//   outFile        optional; if omitted, results JSON goes to stdout
//
// PvPoke is loaded ONCE and pokeA is analyzed against every Pokemon in the
// list. Output is a JSON array with one entry per opponent, in exactly the
// same shape matchup_analyzer.js prints for a single matchup.
// --------------------------------------------------

// PvPoke's own code may console.log debug text. Keep stdout clean by sending
// all such output to stderr (results are written to a file / explicit stdout write).
console.log = (...args) => console.error(...args);

const pokeAInput = process.argv[2];
const listFile = process.argv[3];
const outFile = process.argv[4];

function parsePokemonInput(input){

    const parts = input.split(".");

    return {
        speciesId: parts[0],
        customFastMove:
            parts.length > 1
                ? parts[1]
                : null
    };
}

if (!pokeAInput || !listFile) {
    console.error(
        "Usage: node single_analyzer.js pokeA metaListFile.json [outFile.json]"
    );
    process.exit(1);
}

// --------------------------------------------------
// PvPoke Globals
// --------------------------------------------------

global.host = "https://pvpoke.com";
global.webRoot = "";
global.siteVersion = "test";

// --------------------------------------------------
// Load PvPoke files LIVE from pvpoke.com
//
// Every run downloads the current game logic and data, so move changes,
// meta/ranking updates and engine fixes are picked up automatically.
// (Set PVPOKE_BASE to point at a different host, e.g. a local mirror.)
// --------------------------------------------------

const BASE = (process.env.PVPOKE_BASE || "https://pvpoke.com").replace(/\/$/, "");

// Order matters: this is the same load order as before.
const SCRIPT_URLS = [
    "/js/battle/timeline/TimelineAction.js",
    "/js/battle/timeline/TimelineEvent.js",
    "/js/training/DecisionOption.js",
    "/js/battle/DamageCalculator.js",
    "/js/battle/actions/ActionLogic.js",
    "/js/pokemon/Pokemon.js",
    "/js/GameMaster.js",
    "/js/battle/Battle.js"
];

const GAMEMASTER_URL = "/data/gamemaster.min.json";
const RANKINGS_URL = "/data/rankings/all/overall/rankings-1500.json";

async function download(path){

    let lastError;

    // A couple of retries in case of a transient network hiccup
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(BASE + path);

            if (!res.ok) {
                throw new Error("HTTP " + res.status);
            }

            return await res.text();

        } catch (err) {
            lastError = err;
            await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }

    throw new Error(
        "Could not download " + BASE + path + " (" +
        (lastError && lastError.message || lastError) + ")"
    );
}

// --------------------------------------------------
// The live PvPoke GameMaster.js was written for the website: when it is
// first instantiated it calls jQuery ($.ajax) to fetch the gamemaster and
// to add links to the page menu. None of that is needed here (we download
// the gamemaster ourselves and assign it below), and Node has no jQuery,
// so provide a minimal stand-in: $.each really iterates, everything else
// (ajax, getJSON, DOM selectors) is a harmless no-op.
// --------------------------------------------------

function installJQueryStub(){

    if (typeof global.$ !== "undefined") {
        return;
    }

    const noop = new Proxy(function(){}, {
        get: (target, prop) => (prop === Symbol.toPrimitive ? () => "" : noop),
        apply: () => noop
    });

    const stub = new Proxy(function(){ return noop; }, {
        get: (target, prop) => {

            if (prop === "each") {
                return (collection, callback) => {
                    if (Array.isArray(collection)) {
                        for (let i = 0; i < collection.length; i++) {
                            if (callback.call(collection[i], i, collection[i]) === false) break;
                        }
                    } else if (collection) {
                        for (const key of Object.keys(collection)) {
                            if (callback.call(collection[key], key, collection[key]) === false) break;
                        }
                    }
                    return collection;
                };
            }

            return noop;
        }
    });

    global.$ = stub;
    global.jQuery = stub;
}

let gm;
let rankingsData;

async function loadPvPoke(){

    console.error("Downloading latest PvPoke files...");

    // Fetch everything in parallel, then evaluate in the original order
    const [scripts, gamemasterText, rankingsText] = await Promise.all([
        Promise.all(SCRIPT_URLS.map(download)),
        download(GAMEMASTER_URL),
        download(RANKINGS_URL)
    ]);

    scripts.forEach((code, i) => {
        vm.runInThisContext(code, { filename: SCRIPT_URLS[i] });
    });

    installJQueryStub();

    gm = GameMaster.getInstance();

    gm.data = JSON.parse(gamemasterText);

    gm.originalData = { ...gm.data };

    gm.createSearchMaps();

    rankingsData = JSON.parse(rankingsText);

    gm.rankings = {};
    gm.rankings["alloverall1500"] = rankingsData;
}

// --------------------------------------------------
// Helpers
// --------------------------------------------------

// --------------------------------------------------
// Speed: generateIVCombinations (4096 IV spreads x level search) is by far
// the most expensive call, and its result only depends on the species, its
// moves (Return lowers the IV floor), the league and the level settings.
// Memoize it per unique input so each species is only enumerated once
// instead of ~30 times per matchup. Callers get a copy of the array, so
// in-place sorts (the "cmp" profile) can't corrupt the cache.
// --------------------------------------------------

const ivComboCache = new Map();

function memoizeIVCombinations(pokemon, battle){

    const original = pokemon.generateIVCombinations;

    pokemon.generateIVCombinations = function(
        sortStat, sortDirection, resultCount, filters, ivFloor
    ){

        const key = JSON.stringify([
            pokemon.speciesId,
            pokemon.shadowType || null,
            pokemon.hasMove("RETURN"),
            battle.getCP(),
            pokemon.levelCap,
            pokemon.baseLevelFloor,
            sortStat,
            sortDirection,
            resultCount,
            filters || null,
            ivFloor || null
        ]);

        let cached = ivComboCache.get(key);

        if(!cached){
            cached = original.call(
                pokemon,
                sortStat,
                sortDirection,
                resultCount,
                filters,
                ivFloor
            );
            ivComboCache.set(key, cached);
        }

        return cached.slice();
    };
}

function createPokemon(
    speciesId,
    profileType,
    battle,
    customFastMove = null
){

    const pokemon = new Pokemon(
        speciesId.toLowerCase(),
        0,
        battle
    );

    memoizeIVCombinations(pokemon, battle);

pokemon.initialize(1500);

pokemon.selectRecommendedMoveset();

if (pokemon.hasTag("mega")) {

    const baseSpeciesId =
        pokemon.speciesId
            .replace("_mega", "")
            .replace("_mega_x", "")
            .replace("_mega_y", "");

    const basePokemon =
        new Pokemon(
            baseSpeciesId,
            0,
            battle
        );

    basePokemon.initialize(1500);

    basePokemon.selectRecommendedMoveset();

    pokemon.fastMove =
        basePokemon.fastMove;

    pokemon.chargedMoves =
        basePokemon.chargedMoves;
}

if(customFastMove){

    const move =
        pokemon.fastMovePool.find(
            m =>
                m.moveId.toLowerCase()
                ===
                customFastMove.toLowerCase()
        );

    if(move){
        pokemon.fastMove = move;
    }
}

switch(profileType){

    case "overall":
        pokemon.maximizeStat("overall");
        break;

    case "atk":
        pokemon.maximizeStat("atk");
        break;

    case "def":
        pokemon.maximizeStat("def");
        break;

case "cmp":

    const combinations =
        pokemon.generateIVCombinations(
            "overall",
            1,
            200
        );

    combinations.sort((a,b) => {

        // Highest attack first

        if(b.atk !== a.atk){
            return b.atk - a.atk;
        }

        // If tied attack,
        // highest overall first

        if(b.overall !== a.overall){
            return b.overall - a.overall;
        }

        // If tied attack AND overall,
        // highest HP IV first

        return (
            b.ivs.hp -
            a.ivs.hp
        );
    });

    const cmpSpread =
        combinations[0];

    pokemon.ivs.atk =
        cmpSpread.ivs.atk;

    pokemon.ivs.def =
        cmpSpread.ivs.def;

    pokemon.ivs.hp =
        cmpSpread.ivs.hp;

    pokemon.setLevel(
        cmpSpread.level,
        false
    );

    pokemon.stats.atk =
        pokemon.cpm *
        (
            pokemon.baseStats.atk +
            pokemon.ivs.atk
        );

    pokemon.stats.def =
        pokemon.cpm *
        (
            pokemon.baseStats.def +
            pokemon.ivs.def
        );

    pokemon.stats.hp =
        Math.max(
            Math.floor(
                pokemon.cpm *
                (
                    pokemon.baseStats.hp +
                    pokemon.ivs.hp
                )
            ),
            10
        );

    pokemon.hp =
        pokemon.stats.hp;

    pokemon.startHp =
        pokemon.hp;

    pokemon.cp =
        pokemon.calculateCP();

    break;
}

    return pokemon;
}

function ratingToResult(rating){

    if(rating > 500){
        return "win";
    }

    if(rating < 500){
        return "loss";
    }

    return "tie";
}

// --------------------------------------------------
// Single matchup analysis (logic identical to matchup_analyzer.js)
// --------------------------------------------------

let aProfileCache = null;

function analyzeMatchup(pokeAInfo, pokeBInfo){

    const pokeAId = pokeAInfo.speciesId;
    const pokeBId = pokeBInfo.speciesId;

const breakpointResults = [];

const bulkpointResults = [];

function simulateBattle(
    pokeASpecies,
    pokeAProfile,
    pokeBSpecies,
    pokeBProfile,
    shields
){


    const battle = new Battle();

    const pokeA =
        createPokemon(
            pokeASpecies,
            pokeAProfile,
            battle,
            pokeAInfo.customFastMove
        );


    const pokeB =
        createPokemon(
            pokeBSpecies,
            pokeBProfile,
            battle,
            pokeBInfo.customFastMove
        );

battle.setNewPokemon(pokeA, 0, false);
battle.setNewPokemon(pokeB, 1, false);

pokeA.setShields(shields);
pokeB.setShields(shields);

    battle.simulate();

    const ratings =
        battle.getBattleRatings();

    return {

        pokeARating:
            ratings[0],

        pokeBRating:
            ratings[1]
    };
}

const profileBattle = new Battle();

if(!aProfileCache){
    aProfileCache = {
        def:     createPokemon(pokeAId,"default",profileBattle,pokeAInfo.customFastMove),
        overall: createPokemon(pokeAId,"overall",profileBattle,pokeAInfo.customFastMove),
        atk:     createPokemon(pokeAId,"atk",profileBattle,pokeAInfo.customFastMove),
        cmp:     createPokemon(pokeAId,"cmp",profileBattle,pokeAInfo.customFastMove),
        maxDef:  createPokemon(pokeAId,"def",profileBattle,pokeAInfo.customFastMove)
    };
}

const pokeADefault = aProfileCache.def;
const pokeAOverall = aProfileCache.overall;
const pokeAMaxAtk = aProfileCache.atk;
const pokeACmp = aProfileCache.cmp;
const pokeAMaxDef = aProfileCache.maxDef;

const pokeBCmp =
    createPokemon(pokeBId,"cmp",profileBattle,pokeBInfo.customFastMove);

const pokeBDefault =
    createPokemon(pokeBId,"default",profileBattle,pokeBInfo.customFastMove);

const pokeBOverall =
    createPokemon(pokeBId,"overall",profileBattle,pokeBInfo.customFastMove);

const pokeBMaxDef =
    createPokemon(pokeBId,"def",profileBattle,pokeBInfo.customFastMove);

// --------------------------------------------------
// Breakpoint Matches
// --------------------------------------------------

const fastMove =
    pokeADefault.fastMove;

// Match 1
//
// maxOverall vs maxDef

const BP1_Damage =
    DamageCalculator.damage(
        pokeAOverall,
        pokeBMaxDef,
        fastMove
    );

// Match 2
//
// maxOverall vs maxOverall

const BP2_Damage =
    DamageCalculator.damage(
        pokeAOverall,
        pokeBOverall,
        fastMove
    );

// Match 3
//
// default vs maxOverall

const BP3_Damage =
    DamageCalculator.damage(
        pokeADefault,
        pokeBOverall,
        fastMove
    );

// Match 4
//
// cmpSpread vs maxOverall

const BP4_Damage =
    DamageCalculator.damage(
        pokeACmp,
        pokeBOverall,
        fastMove
    );

// Match 5
//
// maxAtk vs maxOverall

const BP5_Damage =
    DamageCalculator.damage(
        pokeAMaxAtk,
        pokeBOverall,
        fastMove
    );

// --------------------------------------------------
// Bulkpoint Matches
// --------------------------------------------------

// Match 1
//
// default vs cmpSpread

const BK1_Damage =
    DamageCalculator.damage(
        pokeBCmp,
        pokeADefault,
        pokeBCmp.fastMove
    );

// Match 2
//
// maxOverall vs cmpSpread

const BK2_Damage =
    DamageCalculator.damage(
        pokeBCmp,
        pokeAOverall,
        pokeBCmp.fastMove
    );

// Match 3
//
// maxDef vs cmpSpread

const BK3_Damage =
    DamageCalculator.damage(
        pokeBCmp,
        pokeAMaxDef,
        pokeBCmp.fastMove
    );

// Match 4
//
// maxDef vs default

const BK4_Damage =
    DamageCalculator.damage(
        pokeBDefault,
        pokeAMaxDef,
        pokeBDefault.fastMove
    );

// Match 5
//
// maxDef vs maxOverall

const BK5_Damage =
    DamageCalculator.damage(
        pokeBOverall,
        pokeAMaxDef,
        pokeBOverall.fastMove
    );

// --------------------------------------------------
// Breakpoint Exists?
// --------------------------------------------------

const breakpointExists =
    BP5_Damage > BP1_Damage;

const bulkpointExists =
    BK5_Damage < BK1_Damage;

// --------------------------------------------------
// No Breakpoint OR Bulkpoint
// --------------------------------------------------

if(
    !breakpointExists &&
    !bulkpointExists
){

    return (
            {
                pokeA:
                    pokeADefault.speciesName,

                pokeB:
                    pokeBDefault.speciesName,

            breakpoint: {
                exists: false,
                overallTier: 4,
                shieldTiers: {
                    "0s": 4,
                    "1s": 4,
                    "2s": 4
                },
                guaranteedBP: 0,
                defaultBP: 0
            },

            bulkpoint: {
                exists: false,
                overallTier: 4,
                shieldTiers: {
                    "0s": 4,
                    "1s": 4,
                    "2s": 4
                },
                likelyBK: 0,
                highrankBK: 0
            }
            }
    );
}

// --------------------------------------------------
// Breakpoint / Bulkpoint Stat Targets
// --------------------------------------------------

let guaranteedBP = 0;
let defaultBP = 0;

let likelyBK = 0;
let highrankBK = 0;

// -------------------------
// Breakpoints
// -------------------------

if (breakpointExists) {

    // Attack needed to break through
    // maxDef defender

    guaranteedBP =
        DamageCalculator.breakpoint(
            pokeAOverall,
            pokeBMaxDef,
            BP1_Damage + 1,
            pokeBMaxDef.getEffectiveStat(1),
            pokeBDefault.typeEffectiveness[fastMove.type],
            fastMove
        );

    // If impossible even with maxAtk,
    // report 0

    if (
        guaranteedBP >
        pokeAMaxAtk.stats.atk
    ) {
        guaranteedBP = 0;
    }

    // Attack needed to break through
    // default defender

    defaultBP =
        DamageCalculator.breakpoint(
            pokeAOverall,
            pokeBDefault,
            BP1_Damage + 1,
            pokeBDefault.getEffectiveStat(1),
            pokeBDefault.typeEffectiveness[fastMove.type],
            fastMove
        );
}


// -------------------------
// Bulkpoints
// -------------------------

if (bulkpointExists) {

    likelyBK =
        DamageCalculator.bulkpoint(
            pokeBCmp,
            pokeADefault,
            BK1_Damage - 1,
            pokeBCmp.getEffectiveStat(0),
            pokeADefault.typeEffectiveness[pokeBDefault.fastMove.type],
            pokeBCmp.fastMove
        );

    if (
        likelyBK >
        pokeAMaxDef.stats.def
    ) {
        likelyBK = 0;
    }

    highrankBK =
        DamageCalculator.bulkpoint(
            pokeBOverall,
            pokeADefault,
            BK1_Damage - 1,
            pokeBOverall.getEffectiveStat(0),
            pokeADefault.typeEffectiveness[pokeBDefault.fastMove.type],
            pokeBOverall.fastMove
        );
}

const breakpointMatches = [

    {
        name: "BP1",
        profile: "maxOverall_vs_maxDef",
        damage: BP1_Damage,
        pokeAProfile: "overall",
        pokeBProfile: "def"
    },

    {
        name: "BP2",
        profile: "maxOverall_vs_maxOverall",
        damage: BP2_Damage,
        pokeAProfile: "overall",
        pokeBProfile: "overall"
    },

    {
        name: "BP3",
        profile: "default_vs_maxOverall",
        damage: BP3_Damage,
        pokeAProfile: "default",
        pokeBProfile: "overall"
    },

    {
        name: "BP4",
        profile: "cmpSpread_vs_maxOverall",
        damage: BP4_Damage,
        pokeAProfile: "cmp",
        pokeBProfile: "overall"
    },

    {
        name: "BP5",
        profile: "maxAtk_vs_maxOverall",
        damage: BP5_Damage,
        pokeAProfile: "atk",
        pokeBProfile: "overall"
    }
];

const bulkpointMatches = [

    {
        name: "BK1",
        profile: "default_vs_cmpSpread",
        damage: BK1_Damage,
        pokeAProfile: "default",
        pokeBProfile: "cmp"
    },

    {
        name: "BK2",
        profile: "maxOverall_vs_cmpSpread",
        damage: BK2_Damage,
        pokeAProfile: "overall",
        pokeBProfile: "cmp"
    },

    {
        name: "BK3",
        profile: "maxDef_vs_cmpSpread",
        damage: BK3_Damage,
        pokeAProfile: "def",
        pokeBProfile: "cmp"
    },

    {
        name: "BK4",
        profile: "maxDef_vs_default",
        damage: BK4_Damage,
        pokeAProfile: "def",
        pokeBProfile: "default"
    },

    {
        name: "BK5",
        profile: "maxDef_vs_maxOverall",
        damage: BK5_Damage,
        pokeAProfile: "def",
        pokeBProfile: "overall"
    }
];


for(const match of bulkpointMatches){

    const shieldResults = [];

    for(const shields of [0,1,2]){

        const battleResult =
            simulateBattle(
                pokeAId,
                match.pokeAProfile,
                pokeBId,
                match.pokeBProfile,
                shields
            );

        shieldResults.push({

            shields,

            rating:
                battleResult.pokeARating,

            result:
                ratingToResult(
                    battleResult.pokeARating
                )
        });
    }

    bulkpointResults.push({

        match:
            match.name,

        profile:
            match.profile,

        damage:
            match.damage,

        shieldResults
    });
}



for(const match of breakpointMatches){

    const shieldResults = [];

    for(const shields of [0,1,2]){

        const battleResult =
            simulateBattle(
                pokeAId,
                match.pokeAProfile,
                pokeBId,
                match.pokeBProfile,
                shields
            );

        shieldResults.push({

            shields,

            rating:
                battleResult.pokeARating,

            result:
                ratingToResult(
                    battleResult.pokeARating
                )
        });
    }

    breakpointResults.push({

        match:
            match.name,

        profile:
            match.profile,

        damage:
            match.damage,

        shieldResults
    });
}


// --------------------------------------------------
// Breakpoint Tier Calculation
// --------------------------------------------------

const baseDamage =
    BP1_Damage;

const baseMatches =
    breakpointResults.filter(
        m => m.damage === baseDamage
    );

const higherDamageMatches =
    breakpointResults.filter(
        m => m.damage > baseDamage
    );

const breakpointShieldTiers = {

    "0s": 4,
    "1s": 4,
    "2s": 4
};

for(const shields of [0,1,2]){

    const baseShieldResults =
        baseMatches.map(
            match =>
                match.shieldResults.find(
                    r =>
                        r.shields === shields
                )
        );

    const higherShieldResults =
        higherDamageMatches.map(
            match =>
                match.shieldResults.find(
                    r =>
                        r.shields === shields
                )
        );

    const everyImprovedWins =
        higherShieldResults.every(
            r =>
                r.result === "win"
        );

    const everyBaseNotWinning =
        baseShieldResults.every(
            r =>
                r.result !== "win"
        );

    const atLeastOneBaseNotWinning =
        baseShieldResults.some(
            r =>
                r.result !== "win"
        );

    const atLeastOneImprovedWins =
        higherShieldResults.some(
            r =>
                r.result === "win"
        );

    const shieldKey =
    `${shields}s`;

// -------------------------
// Tier 1
// -------------------------

if(
    everyImprovedWins &&
    everyBaseNotWinning
){
    breakpointShieldTiers[
        shieldKey
    ] = 1;

    continue;
}

// -------------------------
// Tier 2
// -------------------------

if(
    everyImprovedWins &&
    atLeastOneBaseNotWinning
){
    breakpointShieldTiers[
        shieldKey
    ] = 2;

    continue;
}

// -------------------------
// Tier 3
// -------------------------

if(
    atLeastOneImprovedWins &&
    atLeastOneBaseNotWinning
){
    breakpointShieldTiers[
        shieldKey
    ] = 3;

    continue;
}

}

const breakpointTier =
    (
        !breakpointExists ||
        higherDamageMatches.length === 0 ||
        BP2_Damage > BP1_Damage
    )
        ? 4
        : Math.min(
            breakpointShieldTiers["0s"],
            breakpointShieldTiers["1s"],
            breakpointShieldTiers["2s"]
        );


// --------------------------------------------------
// Bulkpoint Tier Calculation
// --------------------------------------------------

const bulkBaseDamage = BK1_Damage;

const baseBulkMatches =
    bulkpointResults.filter(
        m => m.damage === bulkBaseDamage
    );

const loweredDamageMatches =
    bulkpointResults.filter(
        m => m.damage < bulkBaseDamage
    );


const bulkpointShieldTiers = {

    "0s": 4,
    "1s": 4,
    "2s": 4
};

for(const shields of [0,1,2]){

    const baseShieldResults =
        baseBulkMatches.map(
            match =>
                match.shieldResults.find(
                    r =>
                        r.shields === shields
                )
        );

    const higherShieldResults =
        loweredDamageMatches.map(
            match =>
                match.shieldResults.find(
                    r =>
                        r.shields === shields
                )
        );

    const everyImprovedWins =
        higherShieldResults.every(
            r =>
                r.result === "win"
        );

    const everyBaseNotWinning =
        baseShieldResults.every(
            r =>
                r.result !== "win"
        );

    const atLeastOneBaseNotWinning =
        baseShieldResults.some(
            r =>
                r.result !== "win"
        );

    const atLeastOneImprovedWins =
        higherShieldResults.some(
            r =>
                r.result === "win"
        );

    const shieldKey =
    `${shields}s`;

// -------------------------
// Tier 1
// -------------------------

if(
    everyImprovedWins &&
    everyBaseNotWinning
){
    bulkpointShieldTiers[
        shieldKey
    ] = 1;

    continue;
}

// -------------------------
// Tier 2
// -------------------------

if(
    everyImprovedWins &&
    atLeastOneBaseNotWinning
){
    bulkpointShieldTiers[
        shieldKey
    ] = 2;

    continue;
}

// -------------------------
// Tier 3
// -------------------------

if(
    atLeastOneImprovedWins &&
    atLeastOneBaseNotWinning
){
    bulkpointShieldTiers[
        shieldKey
    ] = 3;

    continue;
}

}


const bulkpointTier =
    (
        !bulkpointExists ||
        loweredDamageMatches.length === 0
    )
        ? 4
        : Math.min(
            bulkpointShieldTiers["0s"],
            bulkpointShieldTiers["1s"],
            bulkpointShieldTiers["2s"]
        );

// --------------------------------------------------
// Output
// --------------------------------------------------

const output = {

    pokeA:
        pokeADefault.speciesName,

    pokeB:
        pokeBDefault.speciesName,

    breakpoint: {

        exists:
            breakpointExists,

        overallTier:
            breakpointTier,

        shieldTiers:
            breakpointShieldTiers,

        fastMove:
            pokeADefault.fastMove.name,

        guaranteedBP:
            guaranteedBP,

        defaultBP:
            defaultBP
    },

    bulkpoint: {

        exists:
            bulkpointExists,

        overallTier:
            bulkpointTier,

        shieldTiers:
            bulkpointShieldTiers,

        fastMove:
            pokeBDefault.fastMove.name,

        likelyBK:
            likelyBK,

        highrankBK:
            highrankBK
    }
};

return output;
}

// --------------------------------------------------
// Main: pokeA vs the whole list
// --------------------------------------------------

async function main(){

await loadPvPoke();

const pokeAInfo = parsePokemonInput(pokeAInput.toLowerCase());

const metaList = (listFile === "ALL")
    ? rankingsData.map(entry => entry.speciesId)
    : JSON.parse(fs.readFileSync(listFile, "utf8"));

const results = [];
const failures = [];

const startTime = Date.now();

for (let i = 0; i < metaList.length; i++) {

    const pokeBInput = metaList[i];

    if (pokeBInput.toLowerCase() === pokeAInput.toLowerCase()) {
        continue;
    }

    try {
        results.push(
            analyzeMatchup(pokeAInfo, parsePokemonInput(pokeBInput.toLowerCase()))
        );
    } catch (err) {
        failures.push({ pokeB: pokeBInput, error: String(err && err.message || err) });
    }

    if ((i + 1) % 25 === 0 || i === metaList.length - 1) {
        const secs = ((Date.now() - startTime) / 1000).toFixed(0);
        console.error(`  ${i + 1}/${metaList.length} analyzed (${secs}s)`);
    }
}

if (failures.length) {
    console.error(
        "Skipped " + failures.length + ": " +
        failures.map(f => f.pokeB + " (" + f.error + ")").join("; ")
    );
}

const json = JSON.stringify({ results, failures });

if (outFile) {
    fs.writeFileSync(outFile, json);
} else {
    process.stdout.write(json);
}

}

main().catch(err => {
    console.error("ERROR: " + (err && err.message || err));
    process.exit(1);
});
