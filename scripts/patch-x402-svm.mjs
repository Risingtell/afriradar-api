// Lets the facilitator accept payments signed in Phantom. Runs after every npm install.
//
// Phantom now wraps the payment instruction in Lighthouse guards (assertions that make the
// transaction fail if an account is not as the wallet simulated it) and sometimes adds a
// compute-budget instruction. Seen on mainnet, 20 Nov 2026:
//
//   self-paid transfer (P2UUZAeV...): limit, price, guard(10), guard(6), SetLoadedAccountsDataSizeLimit,
//     TransferChecked, memo, guard(6), guard(10)
//   our data request (4ft9Mzwp9d...): limit, price, guard(10) our treasury USDC, guard(6) fee payer,
//     guard(6) buyer USDC, TransferChecked, memo, guard(10) buyer USDC
//   our question deposit (captured from our Worker log): limit, price, guard(6) buyer, guard(6) fee
//     payer, guard(6) buyer USDC, guard(6) channel USDC, guard(6) channel, open, memo, guard(6) buyer,
//     guard(10) buyer USDC
//
// @x402/svm 2.28 accepts guards only after the payment and refuses any compute-budget instruction
// other than the limit and the price, so every Phantom data request (exact) and question deposit
// (the upto channel open) failed verification. 2.31 refuses this layout too and needs @solana/kit 8,
// so until that upgrade this script patches 2.28.
//
// We pay the network fee of every transaction we submit, even one that fails on chain, and a guard
// is exactly an instruction that can make a transaction fail. So the rules keep out every guard
// that something other than the buyer can break:
//  - Lighthouse instructions may sit anywhere after the compute-unit limit and price, at most 10
//    (the question deposit above carries 7; the fee guard and the transaction size limit bound the
//    cost, so the cap is only a sanity bound). After a channel open the stock limit on optional
//    instructions still applies on top: at most 4 (memo included), or 5 when a receiver-binding
//    memo is expected;
//  - each must be an assertion on an account, a mint or a token account (Lighthouse kinds 2, 3,
//    5-10). Refused: MemoryWrite and MemoryClose (0, 1), which move lamports; AccountDelta (4), which
//    needs a MemoryWrite; stake and loader checks (11-14); the clock check (15), which can pass our
//    simulation and fail on chain a slot later; the tree checks (16, 17);
//  - a guard may only check accounts that no other payment changes behind our back: the buyer's
//    own wallet and USDC account, the two channel accounts a question deposit creates (on a
//    top-up the channel already exists and our settlements change it, so there only the buyer's
//    two accounts), our fee payer and, on a data request, our treasury USDC account. Anything
//    else is refused: the USDC mint (its supply moves all the time), sysvars, other people's
//    accounts. The buyer can still make its OWN payments fail on chain by asserting its own
//    accounts and changing them (several payments at once, each guarding its USDC account),
//    costing us one network fee per failure; real wallets guard exactly those accounts, so that
//    cannot be refused here. Stock 2.28 allowed it after the transfer too;
//  - on our fee payer and treasury only checks no settlement can change are accepted, because
//    every settlement LOWERS the fee payer's balance and RAISES the treasury's: a buyer could send
//    many payments at once that each assert "balance is what it is now"; one lands, the rest fail
//    on chain, and we pay for each. Accepted: account-info checks (kinds 5, 6) of the owner (==),
//    the data length, the signer, writable and executable flags and the trivial "lamports >= 0";
//    and on the treasury also token-account checks (kinds 9, 10) of everything except the amount
//    (mint, owner, delegate, state, is-native, delegated amount, close authority, derived owner).
//    Phantom sends exactly such checks: "owner System, data length 0" on the fee payer and
//    "no delegate, delegated amount <= 0, derived owner" on the treasury. Stock 2.28 let any
//    Lighthouse instruction after an exact transfer list any account, our fee payer included;
//  - one SetLoadedAccountsDataSizeLimit is allowed after the limit and price; it changes no fee;
//  - everything else (compute budget, the transfer or the open, memo, amounts, accounts) is
//    checked exactly as before, in the same order.
//
// It edits only the ESM build: the Worker, the tests and every script here load ESM. The CJS build
// stays stock. Idempotent. It fails the install if @x402/svm is not the version it was written for,
// so an upgrade cannot drop the fix silently; test/lighthouse.test.ts checks the behaviour.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MARK = "afriradar-patch:lighthouse-guards:v8";
const ANY_MARK = "afriradar-patch:lighthouse-guards";
const WRITTEN_FOR = "2.28.0";
const root = fileURLToPath(new URL("../node_modules/@x402/svm/", import.meta.url));

function fail(why) {
  console.error(`patch-x402-svm: ${why}`);
  process.exit(1);
}

let version;
try {
  version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
} catch {
  console.log("patch-x402-svm: @x402/svm is not installed here, nothing to patch");
  process.exit(0);
}
if (version !== WRITTEN_FOR) {
  fail(`written for @x402/svm ${WRITTEN_FOR} but found ${version}. Check how the new version treats Phantom's Lighthouse guards, then update or remove scripts/patch-x402-svm.mjs.`);
}

/** Replaces `from` with `to`; `from` must occur exactly once. */
function once(text, from, to, label) {
  const count = text.split(from).length - 1;
  if (count !== 1) fail(`${label}: expected the original code once, found it ${count} times`);
  return text.replace(from, () => to);
}

/** true: already patched by this version; false: stock; an older patch fails the install. */
function patched(text, file) {
  if (text.includes(MARK)) return true;
  if (text.includes(ANY_MARK)) fail(`${file} carries an older patch; reinstall @x402/svm (delete node_modules/@x402/svm, then npm install)`);
  return false;
}

const RULES = [
  `/* ${MARK} (see scripts/patch-x402-svm.mjs in afriradar-api) */`,
  "var AFRIRADAR_MAX_GUARDS = 10;",
  "var AFRIRADAR_GUARD_KINDS = /* @__PURE__ */ new Set([2, 3, 5, 6, 7, 8, 9, 10]);",
  "function afriradarIsGuard(data) {",
  "  return !!data && data.length > 0 && AFRIRADAR_GUARD_KINDS.has(data[0]);",
  "}",
  // Account-info checks (5, 6) that no settlement can change: owner ==, data length, flags, lamports >= 0.
  "function afriradarReadsInfoSafely(data) {",
  "  if (!data || (data[0] !== 5 && data[0] !== 6)) return false;",
  "  let o = 2;",
  "  let count = 1;",
  "  if (data[0] === 6) {",
  "    count = data[o++];",
  "    if (!(count >= 1 && count <= 8)) return false;",
  "  }",
  "  for (let k = 0; k < count; k += 1) {",
  "    const tag = data[o++];",
  "    if (tag === 0) {",
  "      if (o + 9 > data.length || data[o + 8] !== 4) return false;",
  "      for (let b = o; b < o + 8; b += 1) if (data[b] !== 0) return false;",
  "      o += 9;",
  "    } else if (tag === 1) {",
  "      if (o + 9 > data.length) return false;",
  "      o += 9;",
  "    } else if (tag === 2) {",
  "      if (o + 33 > data.length || data[o + 32] !== 0) return false;",
  "      o += 33;",
  "    } else if (tag === 3) {",
  "      if (o + 2 > data.length || data[o + 1] !== 0) return false;",
  "      o += 2;",
  "    } else if (tag >= 5 && tag <= 7) {",
  "      if (o + 2 > data.length) return false;",
  "      o += 2;",
  "    } else {",
  "      return false;",
  "    }",
  "  }",
  "  return o === data.length;",
  "}",
  // Token-account checks (9, 10) that no settlement can change: everything but the amount (tag 2).
  "function afriradarReadsTokenAccountSafely(data) {",
  "  if (!data || (data[0] !== 9 && data[0] !== 10)) return false;",
  "  let o = 2;",
  "  let count = 1;",
  "  if (data[0] === 10) {",
  "    count = data[o++];",
  "    if (!(count >= 1 && count <= 9)) return false;",
  "  }",
  "  for (let k = 0; k < count; k += 1) {",
  "    const tag = data[o++];",
  "    if (tag === 0 || tag === 1) {",
  "      o += 33;",
  "    } else if (tag === 3 || tag === 7) {",
  "      const some = data[o++];",
  "      if (some !== 0 && some !== 1) return false;",
  "      o += (some ? 32 : 0) + 1;",
  "    } else if (tag === 4) {",
  "      o += 2;",
  "    } else if (tag === 5) {",
  "      const some = data[o++];",
  "      if (some !== 0 && some !== 1) return false;",
  "      o += (some ? 8 : 0) + 1;",
  "    } else if (tag === 6) {",
  "      o += 9;",
  "    } else if (tag !== 8) {",
  "      return false;",
  "    }",
  "    if (o > data.length) return false;",
  "  }",
  "  return o === data.length;",
  "}",
  "function afriradarIsDataLimit(data) {",
  "  return !!data && data.length === 5 && data[0] === 4;",
  "}",
  "",
].join("\n");
const NOT_A_GUARD = "a Lighthouse instruction must be an account, mint or token assertion";

// ---------- exact: data requests ----------
const exactPath = join(root, "dist/esm/exact/facilitator/index.mjs");
let exact = readFileSync(exactPath, "utf8");
if (!patched(exact, exactPath)) {
  exact = once(
    exact,
    "var ExactSvmScheme = class {",
    RULES +
      [
        "function afriradarSplitGuards(instructions) {",
        "  const payment = [];",
        "  const guards = [];",
        "  let dataLimits = 0;",
        "  for (let index = 0; index < instructions.length; index += 1) {",
        "    const ix = instructions[index];",
        "    const program = ix.programAddress.toString();",
        "    const isGuard = program === LIGHTHOUSE_PROGRAM_ADDRESS;",
        "    const isDataLimit = program === COMPUTE_BUDGET_PROGRAM_ADDRESS.toString() && ix.data?.[0] === 4;",
        "    if (!isGuard && !isDataLimit) {",
        "      payment.push(ix);",
        "      continue;",
        "    }",
        "    if (index < 2) return { payment, guards, error: ErrTransactionInstructionsLength };",
        "    if (isDataLimit) {",
        "      dataLimits += 1;",
        "      if (!afriradarIsDataLimit(ix.data) || dataLimits > 1) return { payment, guards, error: ErrTransactionInstructionsLength };",
        "      continue;",
        "    }",
        '    if (!afriradarIsGuard(ix.data)) return { payment, guards, error: "invalid_exact_svm_payload_invalid_lighthouse_instruction" };',
        "    guards.push(ix);",
        "  }",
        "  return guards.length > AFRIRADAR_MAX_GUARDS ? { payment, guards, error: ErrTransactionInstructionsLength } : { payment, guards, error: null };",
        "}",
        "function afriradarCheckTransferGuardTargets(guards, buyerAccounts, payTo, facilitatorAddresses) {",
        "  for (const ix of guards) {",
        "    for (const account of ix.accounts ?? []) {",
        "      const address = account.address.toString();",
        "      if (buyerAccounts.includes(address)) continue;",
        "      if (facilitatorAddresses.includes(address)) {",
        "        if (afriradarReadsInfoSafely(ix.data)) continue;",
        "        return ErrFeePayerTransferringFunds;",
        "      }",
        "      if (address === payTo && (afriradarReadsInfoSafely(ix.data) || afriradarReadsTokenAccountSafely(ix.data))) continue;",
        '      return "invalid_exact_svm_payload_invalid_lighthouse_instruction";',
        "    }",
        "  }",
        "  return null;",
        "}",
        "var ExactSvmScheme = class {",
      ].join("\n"),
    "exact: guard helpers",
  );
  exact = once(
    exact,
    [
      "    const instructions = decompileTransactionMessage(compiled).instructions ?? [];",
      "    if (instructions.length < 3 || instructions.length > 7) {",
      "      return false;",
      "    }",
    ].join("\n"),
    [
      "    const split = afriradarSplitGuards(decompileTransactionMessage(compiled).instructions ?? []);",
      "    const instructions = split.payment;",
      "    if (split.error || instructions.length < 3 || instructions.length > 7) {",
      "      return false;",
      "    }",
    ].join("\n"),
    "exact: hasStaticTransferLayout",
  );
  exact = once(
    exact,
    [
      "  async verifyStaticPath(transaction, decompiled, exactSvmPayload, requirements, signerAddresses) {",
      "    const instructions = decompiled.instructions ?? [];",
    ].join("\n"),
    [
      "  async verifyStaticPath(transaction, decompiled, exactSvmPayload, requirements, signerAddresses) {",
      "    const split = afriradarSplitGuards(decompiled.instructions ?? []);",
      "    if (split.error) {",
      '      return { isValid: false, invalidReason: split.error, payer: "" };',
      "    }",
      "    const instructions = split.payment;",
    ].join("\n"),
    "exact: verifyStaticPath split",
  );
  exact = once(
    exact,
    ["    const amount = parsedTransfer.data.amount;", "    if (amount !== BigInt(requirements.amount)) {"].join("\n"),
    [
      "    const afriradarTargets = afriradarCheckTransferGuardTargets(",
      "      split.guards,",
      "      [parsedTransfer.accounts.source.address.toString(), authorityAddress],",
      "      destATA,",
      "      signerAddresses",
      "    );",
      "    if (afriradarTargets) {",
      "      return { isValid: false, invalidReason: afriradarTargets, payer };",
      "    }",
      "    const amount = parsedTransfer.data.amount;",
      "    if (amount !== BigInt(requirements.amount)) {",
    ].join("\n"),
    "exact: guard targets",
  );
  writeFileSync(exactPath, exact);
  console.log("patch-x402-svm: exact facilitator patched");
}

// ---------- upto: the channel open of a question ----------
const esm = join(root, "dist/esm");
const chunkName = readdirSync(esm).find((f) => f.endsWith(".mjs") && readFileSync(join(esm, f), "utf8").includes("function findCanonicalOpenInstruction("));
if (!chunkName) fail("upto: findCanonicalOpenInstruction not found in dist/esm");
const chunkPath = join(esm, chunkName);
let chunk = readFileSync(chunkPath, "utf8");
if (!patched(chunk, chunkPath)) {
  const start = chunk.indexOf("function findCanonicalOpenInstruction(");
  const end = chunk.indexOf("\nfunction ", start + 1);
  if (end === -1) fail("upto: end of findCanonicalOpenInstruction not found");
  let fn = chunk.slice(start, end);
  fn = once(fn, "  let seenPrice = false;\n", "  let seenPrice = false;\n  let afriradarSeenDataLimit = false;\n", "upto: data-limit flag");
  fn = once(
    fn,
    [
      "    } else {",
      "      throw new Error(",
      "        `verifyOpenTransaction: unsupported ComputeBudget instruction type ${data[0]}`",
      "      );",
      "    }",
    ].join("\n"),
    [
      "    } else if (afriradarIsDataLimit(data) && !afriradarSeenDataLimit) {",
      "      afriradarSeenDataLimit = true;",
      "    } else {",
      "      throw new Error(",
      "        `verifyOpenTransaction: unsupported ComputeBudget instruction type ${data[0]}`",
      "      );",
      "    }",
    ].join("\n"),
    "upto: data limit in the compute-budget prefix",
  );
  fn = once(
    fn,
    ["    i += 1;", "  }", "  const openInstruction = instructions[i];"].join("\n"),
    [
      "    i += 1;",
      "  }",
      "  const afriradarOpenGuards = [];",
      "  let afriradarGuardsBeforeOpen = 0;",
      "  while (i < instructions.length) {",
      "    const preIx = instructions[i];",
      "    if (!preIx) break;",
      "    const preProgram = staticAccounts[preIx.programAddressIndex];",
      "    if (preProgram === COMPUTE_BUDGET_PROGRAM_ADDRESS && afriradarIsDataLimit(preIx.data) && !afriradarSeenDataLimit) {",
      '      rejectFeePayerOutsideOpen(preIx, staticAccounts, feePayer, "ComputeBudget");',
      "      afriradarSeenDataLimit = true;",
      "      i += 1;",
      "      continue;",
      "    }",
      "    if (preProgram !== LIGHTHOUSE_PROGRAM_ADDRESS) break;",
      "    if (!afriradarIsGuard(preIx.data)) {",
      `      throw new Error("verifyOpenTransaction: ${NOT_A_GUARD}");`,
      "    }",
      '    if (!afriradarReadsInfoSafely(preIx.data)) rejectFeePayerOutsideOpen(preIx, staticAccounts, feePayer, "Lighthouse");',
      "    afriradarOpenGuards.push(preIx);",
      "    afriradarGuardsBeforeOpen += 1;",
      "    if (afriradarGuardsBeforeOpen > AFRIRADAR_MAX_GUARDS) {",
      "      throw new Error(`verifyOpenTransaction: at most ${AFRIRADAR_MAX_GUARDS} Lighthouse instructions are allowed in an open transaction`);",
      "    }",
      "    i += 1;",
      "  }",
      "  const openInstruction = instructions[i];",
    ].join("\n"),
    "upto: guards before the open",
  );
  fn = once(fn, "  let lighthouseCount = 0;", "  let lighthouseCount = afriradarGuardsBeforeOpen;", "upto: guard count");
  fn = once(
    fn,
    [
      "      if (lighthouseCount > OPEN_MAX_LIGHTHOUSE_INSTRUCTIONS) {",
      "        throw new Error(",
      "          `verifyOpenTransaction: at most ${OPEN_MAX_LIGHTHOUSE_INSTRUCTIONS} Lighthouse instructions are allowed after open`",
      "        );",
      "      }",
      '      rejectFeePayerOutsideOpen(ix, staticAccounts, feePayer, "Lighthouse");',
    ].join("\n"),
    [
      "      if (lighthouseCount > AFRIRADAR_MAX_GUARDS) {",
      "        throw new Error(",
      "          `verifyOpenTransaction: at most ${AFRIRADAR_MAX_GUARDS} Lighthouse instructions are allowed in an open transaction`",
      "        );",
      "      }",
      "      if (!afriradarIsGuard(ix.data)) {",
      `        throw new Error("verifyOpenTransaction: ${NOT_A_GUARD}");`,
      "      }",
      '      if (!afriradarReadsInfoSafely(ix.data)) rejectFeePayerOutsideOpen(ix, staticAccounts, feePayer, "Lighthouse");',
      "      afriradarOpenGuards.push(ix);",
    ].join("\n"),
    "upto: guards after the open",
  );
  fn = once(
    fn,
    ["  return {", "    accountIndices: openInstruction.accountIndices ?? [],"].join("\n"),
    [
      '  afriradarCheckOpenGuardTargets(afriradarOpenGuards, openInstruction, staticAccounts, feePayer, instructionName === "open" ? [0, 5, 6, 7] : instructionName === "top_up" ? [0, 2] : [0]);',
      "  return {",
      "    accountIndices: openInstruction.accountIndices ?? [],",
    ].join("\n"),
    "upto: guard targets",
  );
  const OPEN_TARGETS = [
    // Accounts a guard may check, by the instruction's account slots (`ownSlots`): on an open the
    // buyer's wallet (0) and USDC account (6) and the channel (5) and channel USDC account (7) the
    // open creates; on a top-up only the buyer's wallet (0) and USDC account (2). The fee payer
    // only for checks no settlement can change. Anything else is refused.
    "function afriradarCheckOpenGuardTargets(guards, openInstruction, staticAccounts, feePayer, ownSlots) {",
    "  const slots = openInstruction.accountIndices ?? [];",
    "  const own = new Set(ownSlots.map((slot) => staticAccounts[slots[slot]]).filter((a) => !!a));",
    "  for (const guard of guards) {",
    "    for (const accountIndex of guard.accountIndices ?? []) {",
    "      const account = staticAccounts[accountIndex];",
    "      if (own.has(account)) continue;",
    "      if (account === feePayer && afriradarReadsInfoSafely(guard.data)) continue;",
    "      throw new Error(`verifyOpenTransaction: a Lighthouse instruction may check only the buyer's accounts, the channel being opened, or stable facts about the fee payer; it lists ${account}`);",
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
  chunk = chunk.slice(0, start) + RULES + OPEN_TARGETS + fn + chunk.slice(end);
  writeFileSync(chunkPath, chunk);
  console.log(`patch-x402-svm: upto open verifier patched (${chunkName})`);
}
