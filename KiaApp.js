import React, { useState, useRef, useEffect } from "react";
import {
  View, Text, TouchableOpacity, ScrollView, TextInput,
  StyleSheet, StatusBar, Modal, Vibration, Dimensions, Alert, Linking, Image, RefreshControl, Share, AppState,
} from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as DocumentPicker from "expo-document-picker";
import * as ImageManipulator from "expo-image-manipulator";

const { width } = Dimensions.get("window");
const KIA_STORAGE_KEY = "@kia_receiving_v1";
const OCR_CAPTURE_KEY  = "@kia_ocr_capture_v1";
const USER_IDENTITY_KEY = "@kia_user_identity_v1";
const BOARD_SESSION_KEY = "@kia_board_session_v1";
const WS_SERVER = "wss://csv-server-production-efc6.up.railway.app";
const DEBUG = false; // Set true to enable verbose logging
const HTTP_SERVER = "https://csv-server-production-efc6.up.railway.app";

const USER_COLORS = ["#00E676","#29B6F6","#FFB300","#FF6D00","#E040FB","#F44336","#00BCD4","#CDDC39"];

function generateId() {
  return Math.random().toString(36).slice(2,10).toUpperCase();
}

function generateRoomCode() {
  // 6-char alphanumeric e.g. KIA-7B3F2A
  return "KIA-" + Math.random().toString(36).slice(2,8).toUpperCase();
}

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.getHours().toString().padStart(2,"0") + ":" + d.getMinutes().toString().padStart(2,"0");
}

// ─── DESIGN ──────────────────────────────────────────────────────────────────
const C = {
  bg: "#07090F", s1: "#0D1117", s2: "#141B24", s3: "#1A2332",
  b1: "#1E2D42", green: "#00E676", amber: "#FFB300",
  red: "#F44336", blue: "#29B6F6", orange: "#FF6D00",
  t1: "#EDF2FF", t2: "#8BA3BE", t3: "#4A6680",
};

// ─── BARCODE PARSING ENGINE (verbatim from Android app) ──────────────────────

const ISUZU_DIGIT_ALIASES = {
  'B': '8', 'b': '8', 'A': '8', 'a': '8',
  'O': '0', 'o': '0', 'D': '0',
  'G': '0', 'g': '0', 'Q': '0', 'q': '0',
  'I': '1', 'i': '1', 'l': '1', 'L': '1',
  'Z': '2', 'z': '2', 'S': '5', 's': '5',
  'E': '8', 'e': '8',
};

function correctIsuzuMisreads(data) {
  let result = data;
  for (const [letter, digit] of Object.entries(ISUZU_DIGIT_ALIASES)) {
    result = result.replace(new RegExp(letter, 'g'), digit);
  }
  return result;
}

// Scanners prepend AIM symbology identifiers — strip before parsing
function stripBarcodePrefix(data) {
  return data.replace(/^(\]C1|\]d2|\]Q3|\]e0|\]I0|\]A0)/i, '');
}

// KIA / HYUNDAI / BYD FORMAT DETECTION  ★ HIGHEST PRIORITY ★
// Runs BEFORE Isuzu — if this returns true, barcode goes to parsePartNumber
// directly instead of the Isuzu multi-barcode buffer.
function isKiaHyundaiBydFormat(data, partsDB) {
  let cleaned = stripBarcodePrefix(data).trim().toUpperCase();
  cleaned = cleaned.replace(/^[&@#!$%^*()+=[\\]{}\|\\:;"'<>,.?\/~`]+/, '');
  if (cleaned.includes('&')) cleaned = cleaned.split('&')[0];

  // FASTEST: Direct DB match (raw / dash-stripped / space-stripped)
  if (partsDB && partsDB.length > 0) {
    if (partsDB.some(p => p.partNumber === cleaned)) return true;
    const noDash = cleaned.replace(/-/g, '');
    if (noDash !== cleaned && partsDB.some(p => p.partNumber === noDash)) return true;
    const noSpace = cleaned.replace(/\s+/g, '');
    if (noSpace !== cleaned && partsDB.some(p => p.partNumber === noSpace)) return true;
  }

  // BYD: ends with -00 suffix
  if (cleaned.endsWith('-00') && cleaned.length >= 8) return true;

  // SPACE-SEPARATED: "99241 M6500", "25385 C1600", "93490 2T210"
  if (/^\d{4,6}\s+[A-Z0-9]{3,9}$/.test(cleaned)) {
    const joined = cleaned.replace(/\s+/g, '');
    if (joined.length >= 7) return true;
  }

  // DASHED KIA: "81750-3W000WK", "58302-1GA00"
  if (/^\d{4,6}-[A-Z0-9]{3,10}$/.test(cleaned) && /[A-Z]/.test(cleaned)) return true;

  const a = cleaned.replace(/[\s\-]/g, '');

  // KIA CLASSIC: 5 digits + 1 letter + 4 digits (99241M6500, 86300F1800)
  if (/^\d{5}[A-Z]\d{4}$/.test(a)) return true;

  // HYUNDAI CLASSIC: 5 digits + 5 alphanumeric with letter (583021GA00)
  if (/^\d{5}[A-Z0-9]{5}$/.test(a) && /[A-Z]/.test(a.slice(5))) return true;

  // KIA WIDE: 5-6 leading digits + 3-8 char suffix with letter
  if (/^\d{5,6}[A-Z0-9]{3,8}$/.test(a) && /[A-Z]/.test(a.slice(5))) return true;

  // KIA LONG: 7-10 digits + 1-4 letter suffix (1125406256K)
  if (/^\d{7,10}[A-Z][A-Z0-9]{0,3}$/.test(a)) return true;

  // EMBEDDED LETTER: 9-12 chars, 1-2 letters among 7+ digits
  if (a.length >= 9 && a.length <= 12 && /^[0-9A-Z]+$/.test(a)) {
    const dc = (a.match(/\d/g) || []).length;
    const lc = a.length - dc;
    if (lc >= 1 && lc <= 2 && dc >= 7 && /\d{4,}[A-Z]/.test(a)) return true;
  }

  // 7-DIGIT KIA ACCESSORY (3426889) — only if in DB
  if (/^\d{7}$/.test(a) && partsDB && partsDB.some(p => p.partNumber === a)) return true;

  return false;
}

// ISUZU FORMAT DETECTION
// Only called when isKiaHyundaiBydFormat returned false
function isIsuzuFormat(data) {
  const cleaned = data.trim();
  if (/^\d-\d{8}-\d$/.test(cleaned)) return true;
  if (cleaned.length === 12 && cleaned[1] === '-' && cleaned[10] === '-') return true;
  if (/^\d{10}$/.test(cleaned)) return true;
  if (/^[7-9]\d{7}$/.test(cleaned)) return true;
  if (cleaned.length === 10 && /[A-Z]/i.test(cleaned)) {
    if (/^\d{5,}[A-Z]/i.test(cleaned)) return false;
    const digitCount = (cleaned.match(/\d/g) || []).length;
    if (digitCount >= 7) {
      const corrected = correctIsuzuMisreads(cleaned.toUpperCase());
      if (/^\d{10}$/.test(corrected)) return true;
    }
  }
  if (cleaned.length === 8 && (cleaned.match(/\d/g) || []).length >= 6) {
    const corrected = correctIsuzuMisreads(cleaned.toUpperCase());
    if (/^[7-9]\d{7}$/.test(corrected)) return true;
  }
  return false;
}

// Normalize a single scan to 10 digits (best-effort, returns null for 8-digit partials)
function normalizeIsuzuPartNumber(data) {
  const cleaned = data.trim();
  if (/^\d-\d{8}-\d$/.test(cleaned)) return cleaned.replace(/-/g, '');
  if (cleaned.length === 12 && cleaned[1] === '-' && cleaned[10] === '-') {
    const inner = cleaned[0] + cleaned.slice(2, 10) + cleaned[11];
    const corrected = correctIsuzuMisreads(inner);
    if (/^\d{10}$/.test(corrected)) return corrected;
  }
  if (/^\d{10}$/.test(cleaned)) return cleaned;
  if (cleaned.length === 10) {
    const corrected = correctIsuzuMisreads(cleaned);
    if (/^\d{10}$/.test(corrected)) return corrected;
  }
  return null;
}

// CORE: Cross-reference all buffered scans to find the most likely part number
// Returns { partNumber, confidence, methods } or null
function resolveIsuzuFromBuffer(buffer, partsDB) {
  if (!buffer || buffer.length === 0 || !partsDB || partsDB.length === 0) return null;

  const t0 = Date.now();

  const dbDigitsMap = new Map();
  const dbPrefixMap = new Map();
  for (const p of partsDB) {
    const digits = p.partNumber.replace(/\D/g, '');
    if (digits.length === 10) {
      dbDigitsMap.set(digits, p.partNumber);
      const prefix9 = digits.slice(0, 9);
      if (!dbPrefixMap.has(prefix9)) dbPrefixMap.set(prefix9, []);
      dbPrefixMap.get(prefix9).push(digits);
    }
  }

  const gmCandidates = [];
  const partCandidates = [];

  for (const scan of buffer) {
    const raw = scan.data.trim();
    let data = raw;
    if (raw.length === 12 && raw[1] === '-' && raw[10] === '-') {
      data = raw[0] + raw.slice(2, 10) + raw[11];
    }
    if (data.length === 8) {
      const corrected = correctIsuzuMisreads(data);
      const rawDigits = data.replace(/\D/g, '');
      gmCandidates.push({ raw: data, corrected, digits: /^\d{8}$/.test(corrected) ? corrected : rawDigits, y: scan.y });
    } else if (data.length === 10) {
      const corrected = correctIsuzuMisreads(data);
      const rawDigits = data.replace(/\D/g, '');
      const leadingDigits = (data.match(/^\d+/) || [''])[0];
      partCandidates.push({ raw: data, corrected, digits: rawDigits, leading: leadingDigits, y: scan.y });
    }
  }

  DEBUG && console.log(`Isuzu resolve: ${gmCandidates.length} GM#, ${partCandidates.length} part scans`);

  const scores = new Map();
  const addScore = (pn, points, method) => {
    const existing = scores.get(pn) || { score: 0, methods: [] };
    existing.score += points;
    existing.methods.push(method);
    scores.set(pn, existing);
  };

  // Evidence from GM# scans (top barcode)
  for (const gm of gmCandidates) {
    if (gm.digits.length >= 7) {
      const prefix = '8' + gm.digits;
      const matches = dbPrefixMap.get(prefix.slice(0, 9)) || [];
      for (const pn of matches) {
        addScore(pn, 60, `GM#:${gm.raw}→prefix:${prefix.slice(0, 9)}`);
      }
      if (matches.length === 0) {
        const shortPrefix = prefix.slice(0, 8);
        for (const [pre9, parts] of dbPrefixMap) {
          if (pre9.startsWith(shortPrefix)) {
            for (const pn of parts) addScore(pn, 40, `GM#:${gm.raw}→short:${shortPrefix}`);
          }
        }
      }
    }
  }

  // Evidence from part scans (bottom barcode)
  for (const ps of partCandidates) {
    // Method A: Exact corrected match (highest confidence)
    if (/^\d{10}$/.test(ps.corrected) && dbDigitsMap.has(ps.corrected)) {
      addScore(ps.corrected, 100, `exact:${ps.raw}→${ps.corrected}`);
    }
    // Method B: Leading digit prefix match
    if (ps.leading.length >= 6) {
      for (const [digits10] of dbDigitsMap) {
        if (digits10.startsWith(ps.leading)) {
          addScore(digits10, 30 + ps.leading.length * 5, `prefix:${ps.leading}(${ps.leading.length}d)`);
        }
      }
    }
    // Method C: All extracted digits as substring
    if (ps.digits.length >= 7) {
      for (const [digits10] of dbDigitsMap) {
        if (digits10.includes(ps.digits)) {
          addScore(digits10, 25 + ps.digits.length * 3, `substr:${ps.digits}`);
        }
      }
    }
    // Method D: Digit similarity (Levenshtein)
    if (ps.digits.length >= 7) {
      let bestSim = 0;
      let bestPN = null;
      for (const [digits10] of dbDigitsMap) {
        if (Math.abs(ps.digits.length - 10) > 3) continue;
        const sim = calculateSimilarity(ps.digits, digits10);
        if (sim >= 90 && sim > bestSim) { bestSim = sim; bestPN = digits10; }
      }
      if (bestPN) addScore(bestPN, Math.round(bestSim * 0.4), `sim:${Math.round(bestSim)}%`);
    }
    // Method E: Corrected value not in DB but valid 10-digit (low confidence)
    if (/^\d{10}$/.test(ps.corrected) && !dbDigitsMap.has(ps.corrected)) {
      addScore(ps.corrected, 15, `corrected-nodb:${ps.raw}`);
    }
  }

  // Cross-reference bonus: confirmed by BOTH GM# and part scan
  for (const [pn, info] of scores) {
    const fromGM = info.methods.some(m => m.startsWith('GM#'));
    const fromPart = info.methods.some(m => !m.startsWith('GM#'));
    if (fromGM && fromPart) {
      info.score += 80;
      info.methods.push('CROSS-REF-BONUS');
    }
  }

  let bestPN = null, bestScore = 0, bestMethods = [];
  for (const [pn, info] of scores) {
    if (info.score > bestScore) { bestScore = info.score; bestPN = pn; bestMethods = info.methods; }
  }

  if (bestPN) {
    DEBUG && console.log(`Isuzu resolved: ${bestPN} (score:${bestScore}, ${Date.now() - t0}ms)`);
    DEBUG && console.log(`  Methods: ${bestMethods.join(' | ')}`);
    return { partNumber: bestPN, confidence: bestScore, methods: bestMethods };
  }

  // Last resort: best-effort even without DB match
  for (const ps of partCandidates) {
    if (/^\d{10}$/.test(ps.corrected)) {
      DEBUG && console.log(`Isuzu last-resort (corrected, no DB): ${ps.corrected}`);
      return { partNumber: ps.corrected, confidence: 15, methods: ['last-resort-corrected'] };
    }
  }
  for (const gm of gmCandidates) {
    if (/^\d{8}$/.test(gm.digits)) {
      for (let d = 0; d <= 9; d++) {
        const candidate = '8' + gm.digits + d;
        if (dbDigitsMap.has(candidate)) {
          DEBUG && console.log(`Isuzu last-resort (GM#+check): ${candidate}`);
          return { partNumber: candidate, confidence: 30, methods: ['gm-checkdigit-bruteforce'] };
        }
      }
    }
  }

  DEBUG && console.log(`Isuzu: no resolution found (${Date.now() - t0}ms)`);
  return null;
}

// Levenshtein distance for fuzzy matching
function levenshteinDistance(str1, str2) {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix = [];
  for (let i = 0; i <= len1; i++) matrix[i] = [i];
  for (let j = 0; j <= len2; j++) matrix[0][j] = j;
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      if (str1.charAt(i - 1) === str2.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[len1][len2];
}

function calculateSimilarity(str1, str2) {
  const distance = levenshteinDistance(str1, str2);
  const maxLength = Math.max(str1.length, str2.length);
  return ((maxLength - distance) / maxLength) * 100;
}

function isLikelyPartNumber(str) {
  if (!str || str.length < 5) return false;
  const digitCount = (str.match(/\d/g) || []).length;
  if (digitCount < 2) return false;
  if (digitCount / str.length < 0.25) return false;
  if (/^[A-Z]+$/i.test(str)) return false;
  return true;
}

function parsePartNumber(scannedData, partsDB) {
  let cleaned = stripBarcodePrefix(scannedData).trim().toUpperCase();

  // CRITICAL FIX 0: Strip special characters from the START
  cleaned = cleaned.replace(/^[&@#!$%^*()+=[\\]{}\|\\:;"'<>,.?\/~`]+/, '');
  DEBUG && console.log(`After stripping special chars: ${scannedData} → ${cleaned}`);

  // CRITICAL FIX 0.5: Strip & and everything after it (common in Kia parts)
  if (cleaned.includes('&')) {
    cleaned = cleaned.split('&')[0];
    DEBUG && console.log(`Stripped & and after: ${scannedData} → ${cleaned}`);
  }

  // CRITICAL FIX 0.6: Strip 2-letter make prefixes unconditionally (KI=KIA, HY=HYUNDAI, IS=ISUZU, BY=BYD etc)
  const MAKE_PREFIXES_PARSE = ['KI', 'HY', 'IS', 'BY', 'TO', 'HO', 'MI', 'NI', 'SU', 'MA', 'MZ'];
  for (const prefix of MAKE_PREFIXES_PARSE) {
    if (cleaned.startsWith(prefix) && cleaned.length > prefix.length + 4 && /\d/.test(cleaned[prefix.length])) {
      const stripped = cleaned.substring(prefix.length);
      // Always strip if the remainder looks like a part number (digit-led or DB match)
      if (
        partsDB && partsDB.some(p => p.partNumber === stripped) ||
        /^\d{5,}/.test(stripped) ||
        /^[A-Z0-9]{6,}/.test(stripped)
      ) {
        DEBUG && console.log(`Stripped make prefix "${prefix}": ${cleaned} → ${stripped}`);
        cleaned = stripped;
        break;
      }
    }
  }

  // CRITICAL FIX 1: Handle spaces in Kia part numbers
  const kiaWithSpaceMatch = cleaned.match(/^(\d{4,6})\s+([A-Z0-9]{3,9})$/);
  if (kiaWithSpaceMatch) {
    const combined = kiaWithSpaceMatch[1] + kiaWithSpaceMatch[2];
    if (combined.length >= 8 && /\d/.test(combined)) {
      DEBUG && console.log(`Kia format with space detected: ${cleaned} → ${combined}`);
      cleaned = combined;
    }
  } else {
    const spaceSplit = cleaned.split(/\s+/);
    if (spaceSplit.length > 1) {
      DEBUG && console.log(`Split by space: ${cleaned} → Taking first element: ${spaceSplit[0]}`);
      cleaned = spaceSplit[0];
    }
  }

  // CRITICAL FIX 2: Strip production codes from the END (when no space)
  // BUT protect meaningful suffixes like -AS, -DS, -SA, -OE etc (dash-separated)
  const hasDashSuffix = /-[A-Z]{1,4}(\d{1,3})?$/.test(cleaned);
  if (!hasDashSuffix) {
    const productionCodePattern = /[A-Z]{2,4}\d{1,3}$/;
    if (productionCodePattern.test(cleaned)) {
      const withoutCode = cleaned.replace(productionCodePattern, '');
      if (withoutCode.length >= 8) {
        DEBUG && console.log(`Stripped production code: ${cleaned} → ${withoutCode}`);
        cleaned = withoutCode;
      }
    }
  }

  if (cleaned.length < 6) {
    DEBUG && console.log(`Rejected: Too short (${cleaned})`);
    return null;
  }

  const invalidPatterns = [
    /^QTY/i,
    /^[A-Z]{2}\d{1,3}$/,
    /^[A-Z]{3}\d{1,3}$/,
    /^[A-Z]{4}\d{1,2}$/,
    /^PC$/i,
    /^MADE/i,
    /^[A-Z]+$/,
  ];
  for (const pattern of invalidPatterns) {
    if (pattern.test(cleaned)) {
      DEBUG && console.log(`Rejected: Invalid pattern (${cleaned})`);
      return null;
    }
  }

  // Pattern A: 5-6 digits + 4-8 alphanumeric (must have at least one letter in suffix)
  const kiaMatchA = cleaned.match(/^(\d{5,6})([A-Z0-9]{4,8}[A-Z]+[A-Z0-9]*)$/);
  if (kiaMatchA) {
    const partNumber = kiaMatchA[1] + kiaMatchA[2];
    DEBUG && console.log(`Kia format A detected: ${partNumber}`);
    return partNumber;
  }

  // Pattern B: 7-10 digits + 1-4 letter/alphanumeric suffix
  const kiaMatchB = cleaned.match(/^(\d{7,10})([A-Z][A-Z0-9]{0,3})$/);
  if (kiaMatchB) {
    const partNumber = kiaMatchB[1] + kiaMatchB[2];
    DEBUG && console.log(`Kia format B detected: ${partNumber}`);
    return partNumber;
  }

  // Pattern C: Digits-letter-digits mixed (letter embedded in middle/end)
  if (cleaned.length >= 9 && cleaned.length <= 12 && /^[0-9A-Z]+$/.test(cleaned)) {
    const digitCount = (cleaned.match(/\d/g) || []).length;
    const letterCount = cleaned.length - digitCount;
    if (letterCount >= 1 && letterCount <= 2 && digitCount >= 8) {
      const hasEmbeddedLetter = /\d[A-Z]\d/.test(cleaned) || /\d[A-Z]$/.test(cleaned);
      if (hasEmbeddedLetter) {
        DEBUG && console.log(`Kia format C (embedded letter) detected: ${cleaned}`);
        return cleaned;
      }
    }
  }

  // Isuzu dashed format: X-XXXXXXXX-X
  if (cleaned.length === 12 && cleaned[1] === '-' && cleaned[10] === '-') {
    const digitsOnly = cleaned[0] + cleaned.slice(2, 10) + cleaned[11];
    if (/^\d{10}$/.test(digitsOnly)) return digitsOnly;
  }

  // 10-digit Isuzu
  if (cleaned.length === 10 && /^\d{10}$/.test(cleaned)) return cleaned;

  // Isuzu misread correction
  if (cleaned.length === 10 && /[A-Z]/.test(cleaned)) {
    const digitCount = (cleaned.match(/\d/g) || []).length;
    const letterCount = 10 - digitCount;
    if (digitCount >= 8 && letterCount <= 2) {
      const corrected = correctIsuzuMisreads(cleaned);
      if (/^\d{10}$/.test(corrected)) {
        if (partsDB && partsDB.some(p => p.partNumber === cleaned)) {
          DEBUG && console.log(`Isuzu correction blocked — "${cleaned}" exists in DB as Kia/Hyundai`);
          return cleaned;
        }
        DEBUG && console.log(`Isuzu misread in parsePartNumber: "${cleaned}" → "${corrected}"`);
        return corrected;
      }
    }
  }

  // 7-digit codes (Kia accessories/fluids)
  if (cleaned.length === 7 && /^\d{7}$/.test(cleaned)) {
    if (partsDB && partsDB.some(p => p.partNumber === cleaned)) {
      DEBUG && console.log(`7-digit DB match: ${cleaned}`);
      return cleaned;
    }
    return { partial: true, digits: cleaned };
  }

  // 8-digit codes
  if (cleaned.length === 8 && /^\d{8}$/.test(cleaned)) {
    if (/^[7-9]\d{7}$/.test(cleaned)) {
      DEBUG && console.log(`Rejected: 8-digit Isuzu partial (${cleaned})`);
      return null;
    }
    return { partial: true, digits: cleaned };
  }

  // Fast path: standard alphanumeric format
  if (cleaned.length >= 7 && /^[0-9A-Z]{7,15}$/.test(cleaned) && /\d/.test(cleaned)) {
    return cleaned;
  }

  // Preserve -00 suffix for BYD parts
  let preservedSuffix = '';
  if (cleaned.endsWith('-00')) {
    preservedSuffix = '-00';
    cleaned = cleaned.slice(0, -3);
  }

  cleaned = cleaned.replace(/[\s\-_]/g, '');

  if (cleaned.length >= 7 && /\d/.test(cleaned + preservedSuffix)) {
    return cleaned + preservedSuffix;
  }

  return null;
}

// ─── OCR ENGINE ───────────────────────────────────────────────────────────────
const VISION_KEY = "AIzaSyDZ5j5Rj2NtXfwPop2dNafUThQW8ZHhfJA";

const _ocrCache = { partsSet: new Set(), dbDigits: [], builtFor: 0 };

function ensureOCRCache(partsDB) {
  const db = partsDB || [];
  if (_ocrCache.builtFor === db.length && _ocrCache.partsSet.size > 0) return;
  _ocrCache.partsSet = new Set(db.map(p => p.partNumber));
  _ocrCache.dbDigits = db.map(p => { const digits = p.partNumber.replace(/\D/g, ""); return { partNumber: p.partNumber, digits, len: digits.length }; });
  _ocrCache.builtFor = db.length;
}

function extractWordLevelData(fullTextAnnotation) {
  if (!fullTextAnnotation?.pages) return [];
  const words = [];
  const pageWidth = fullTextAnnotation.pages[0]?.width || 1;
  const pageHeight = fullTextAnnotation.pages[0]?.height || 1;
  for (const page of fullTextAnnotation.pages) {
    for (const block of (page.blocks || [])) {
      const blockConf = block.confidence || 0;
      for (const paragraph of (block.paragraphs || [])) {
        for (const word of (paragraph.words || [])) {
          const text = (word.symbols || []).map(s => s.text).join("");
          const confidence = word.confidence ?? blockConf;
          const vertices = word.boundingBox?.vertices || word.boundingBox?.normalizedVertices || [];
          let centerX = 0.5, centerY = 0.5;
          if (vertices.length >= 4) {
            const xs = vertices.map(v => v.x || 0);
            const ys = vertices.map(v => v.y || 0);
            centerX = (Math.min(...xs) + Math.max(...xs)) / 2 / pageWidth;
            centerY = (Math.min(...ys) + Math.max(...ys)) / 2 / pageHeight;
          }
          if (text.length >= 2) words.push({ text: text.toUpperCase(), confidence, centerX, centerY, distFromCenter: Math.sqrt(Math.pow(centerX - 0.5, 2) + Math.pow(centerY - 0.5, 2)) });
        }
      }
    }
  }
  return words;
}

function generateOCRCandidates(extractedText, wordData) {
  if (!extractedText?.trim()) return [];
  const MAX_CANDIDATES = 40;
  const candidates = [];
  const seen = new Set();
  const add = (val, score) => {
    if (val && !seen.has(val) && candidates.length < MAX_CANDIDATES && (val.match(/\d/g) || []).length >= 2 && !/^[A-Z]+$/i.test(val)) {
      seen.add(val); candidates.push({ text: val, score: score || 0 });
    }
  };
  const skipWordsSet = new Set(["GENUINE","PARTS","KIA","HYUNDAI","ISUZU","BYD","MADE","IN","KOREA","CHINA","QTY","QUANTITY","ASSY","OEM","JAPAN","DATE","TIME","BATCH","ITEM","ORDER","PART","CODE","NUMBER","LOCATION","DESCRIPTION","LABEL","WARNING","CAUTION","FRAGILE"]);
  if (wordData?.length > 0) {
    const scoredWords = wordData.filter(w => !skipWordsSet.has(w.text) && w.text.length >= 3 && /\d/.test(w.text)).map(w => ({ ...w, score: w.confidence * (1.0 - w.distFromCenter * 0.5) })).sort((a, b) => b.score - a.score);
    for (const w of scoredWords) { if (w.text.length >= 3) add(w.text, w.score); }
    const byPosition = [...scoredWords].sort((a, b) => { const yDiff = Math.abs(a.centerY - b.centerY); if (yDiff > 0.05) return a.centerY - b.centerY; return a.centerX - b.centerX; });
    for (let i = 0; i < byPosition.length - 1; i++) {
      const w1 = byPosition[i], w2 = byPosition[i + 1];
      if (Math.abs(w1.centerY - w2.centerY) < 0.05) { const joined = w1.text + w2.text; if (joined.length >= 5 && joined.length <= 16 && /\d/.test(joined)) add(joined, (w1.score + w2.score) / 2); }
    }
    for (let i = 0; i < byPosition.length - 2; i++) {
      const w1 = byPosition[i], w2 = byPosition[i + 1], w3 = byPosition[i + 2];
      if (Math.abs(w1.centerY - w2.centerY) < 0.05 && Math.abs(w2.centerY - w3.centerY) < 0.05) { const joined = w1.text + w2.text + w3.text; if (joined.length >= 8 && joined.length <= 16 && /\d/.test(joined)) add(joined, (w1.score + w2.score + w3.score) / 3); }
    }
  }
  const lines = extractedText.split("\n");
  const skipWords = new Set(["GENUINE","PARTS","KIA","HYUNDAI","MADE","IN","KOREA","QTY","QUANTITY","WARNING","CAUTION"]);
  for (let li = 0; li < lines.length && candidates.length < MAX_CANDIDATES; li++) {
    const trimmed = lines[li].trim(); if (!trimmed || trimmed.length < 3) continue;
    const upper = trimmed.toUpperCase(); if (!/\d/.test(upper)) continue;
    const words2 = upper.split(/\s+/).map(w => w.replace(/[^A-Z0-9\-]/g, "")).filter(w => w.length >= 2);
    for (const w of words2) { if (!skipWords.has(w) && w.length >= 3) add(w, 0); }
    for (let i = 0; i < words2.length - 1; i++) { const joined = words2[i] + words2[i + 1]; if (joined.length >= 5 && joined.length <= 16) add(joined, 0); }
    const lineClean = upper.replace(/[\s\-]+/g, "").replace(/[^A-Z0-9]/g, ""); if (lineClean.length >= 5 && lineClean.length <= 16) add(lineClean, 0);
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.map(c => c.text);
}

function extractPartNumbersFromOCR(extractedText, partsDB, wordData) {
  const rawCandidates = generateOCRCandidates(extractedText, wordData);
  if (rawCandidates.length === 0) return [];
  ensureOCRCache(partsDB);
  const { partsSet, dbDigits } = _ocrCache;
  const MAKE_PREFIXES = ["KI","HY","IS","BY","TO","HO","MI","NI","SU","MA","MZ"];
  const candidates = [];
  const seenC = new Set();
  for (const c of rawCandidates) {
    if (!seenC.has(c)) { seenC.add(c); candidates.push(c); }
    const upper = c.toUpperCase();
    for (const prefix of MAKE_PREFIXES) {
      if (upper.startsWith(prefix) && upper.length > prefix.length + 4 && /\d/.test(upper[prefix.length])) {
        const stripped = c.substring(prefix.length); if (!seenC.has(stripped)) { seenC.add(stripped); candidates.push(stripped); }
      }
    }
  }
  const results = [];
  const seen2 = new Set();
  const addResult = (pn, phase) => { if (!seen2.has(pn) && pn.length >= 6 && pn.length <= 20 && isLikelyPartNumber(pn)) { seen2.add(pn); results.push(pn); } };
  // Phase 1: exact DB match
  for (const c of candidates) { if (partsSet.has(c)) addResult(c, 1); }
  if (results.length > 0) return results;
  // Phase 2: parsePartNumber → DB
  const parseCache = new Map();
  for (const c of candidates) { const parsed = parsePartNumber(c, partsDB); parseCache.set(c, parsed); if (parsed && typeof parsed === "string" && partsSet.has(parsed)) addResult(parsed, 2); }
  if (results.length > 0) return results;
  // Phase 3: single char swaps
  const charSwaps = [["O","0"],["0","O"],["I","1"],["1","I"],["S","5"],["5","S"],["Z","2"],["2","Z"],["B","8"],["8","B"],["G","6"],["6","G"]];
  for (const c of candidates.slice(0, 12)) {
    for (const [from, to] of charSwaps) {
      if (!c.includes(from)) continue;
      for (let i = 0; i < c.length; i++) {
        if (c[i] !== from) continue;
        const corrected = c.substring(0, i) + to + c.substring(i + 1);
        if (partsSet.has(corrected)) { addResult(corrected, 3); break; }
        const parsed = parsePartNumber(corrected, partsDB); if (parsed && typeof parsed === "string" && partsSet.has(parsed)) { addResult(parsed, 3); break; }
      }
      if (results.length > 0) break;
    }
    if (results.length > 0) return results;
  }
  // Phase 4: parsePartNumber format only
  for (const c of candidates) { if (c.length < 5 || c.length > 16) continue; const parsed = parseCache.get(c) || parsePartNumber(c, partsDB); if (parsed && typeof parsed === "string") addResult(parsed, 4); }
  if (results.length > 0) return results;
  // Phase 5: fuzzy digit match
  let bestPN = null, bestSim = 0;
  for (const c of candidates.slice(0, 8)) {
    const cDigits = c.replace(/\D/g, ""); if (cDigits.length < 4) continue;
    for (const { partNumber, digits: pDigits, len: pLen } of dbDigits) {
      if (Math.abs(cDigits.length - pLen) > 3) continue;
      const sim = calculateSimilarity(cDigits, pDigits);
      if (sim > bestSim && sim >= 90) { bestSim = sim; bestPN = partNumber; }
    }
  }
  if (bestPN) addResult(bestPN, 5);
  return results;
}
// ─────────────────────────────────────────────────────────────────────────────
// ─── BARCODE SCANNER ─────────────────────────────────────────────────────────
function BarcodeScanner({ visible, onScanned, onClose, title, partsDB, invoiceMode, deliverRaw, torchEnabled, initialKeyboard, initialOcr }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(!!initialKeyboard);
  const [keyboardInput, setKeyboardInput] = useState("");
  const [ocrProcessing, setOcrProcessing] = useState(false);
  const [ocrMode, setOcrMode] = useState(!!initialOcr);
  useEffect(() => {
    if (keyboardVisible) {
      setTimeout(() => keyboardInputRef.current?.focus(), 100);
    }
  }, [keyboardVisible]);
  const cameraRef = useRef(null);
  const keyboardInputRef = useRef(null);
  const lastScanTimeRef = useRef(0);
  const lastScannedDataRef = useRef('');
  const isuzuBufferRef = useRef([]);
  const isuzuTimerRef = useRef(null);
  const SCAN_COOLDOWN_MS = 800;
  const ISUZU_BUFFER_MS = 1000;

  useEffect(() => {
    if (visible) {
      setScanned(false);
      lastScanTimeRef.current = 0;
      lastScannedDataRef.current = '';
      isuzuBufferRef.current = [];
      if (isuzuTimerRef.current) clearTimeout(isuzuTimerRef.current);
      // Apply initial mode every time scanner opens
      setKeyboardVisible(!!initialKeyboard);
      setOcrMode(!!initialOcr);
      setKeyboardInput("");
    }
    return () => {
      if (isuzuTimerRef.current) clearTimeout(isuzuTimerRef.current);
    };
  }, [visible]);

  const deliver = (partNumber) => {
    if (scanned) return;
    setScanned(true);
    Vibration.vibrate(80);
    onScanned(partNumber);
  };

  const processIsuzuBuffer = () => {
    const buffer = [...isuzuBufferRef.current];
    isuzuBufferRef.current = [];
    isuzuTimerRef.current = null;
    if (buffer.length === 0) return;
    DEBUG && console.log(`Isuzu buffer processing: ${buffer.length} barcodes`);
    buffer.forEach(s => DEBUG && console.log(`  "${s.data}" Y=${s.y}`));
    const result = resolveIsuzuFromBuffer(buffer, partsDB || []);
    if (result) {
      DEBUG && console.log(`Isuzu resolved → ${result.partNumber} (confidence:${result.confidence})`);
      lastScanTimeRef.current = Date.now();
      lastScannedDataRef.current = result.partNumber;
      deliver(result.partNumber);
      return;
    }
    // Last resort: fuzzy fallback on any 8-digit scan — just deliver it and let caller handle
    const any8 = buffer.find(s => s.data.length === 8 && (s.data.match(/\d/g) || []).length >= 6);
    if (any8) deliver(correctIsuzuMisreads(any8.data));
    else DEBUG && console.log('Isuzu: no resolution possible');
  };

  const handleBarCodeScanned = (event) => {
    const { data, bounds, cornerPoints } = event;
    if (scanned) return;

    const now = Date.now();

    // Cooldown check
    if (now - lastScanTimeRef.current < SCAN_COOLDOWN_MS) return;

    // Skip if same barcode data as last scan (prevents flickering)
    if (data === lastScannedDataRef.current && now - lastScanTimeRef.current < 3000) return;

    // INVOICE MODE — just deliver raw barcode as invoice number, no part parsing
    if (invoiceMode) {
      const raw = stripBarcodePrefix(data).trim();
      if (raw.length < 3) return;
      lastScanTimeRef.current = now;
      lastScannedDataRef.current = data;
      deliver(raw);
      return;
    }

    // For deliverRaw mode (Find Part) — fire raw barcode first so caller can use it too
    const rawForLookup = stripBarcodePrefix(data).trim();
    if (deliverRaw && rawForLookup.length >= 5) {
      onScanned('__RAW__' + rawForLookup);
    }

    // Pre-filter
    let trimmedData = data.trim().toUpperCase();
    trimmedData = trimmedData.replace(/^[&@#!$%^*()+=[\\]{}\|\\:;"'<>,.?\/~`]+/, '');

    if (trimmedData.length < 6) return;
    if (/^[A-Z]{2}\d{1,3}$/.test(trimmedData) || /^[A-Z]{3}\d{1,3}$/.test(trimmedData)) return;

    const db = partsDB || [];

    // ===== KIA / HYUNDAI / BYD PRIORITY =====
    if (isKiaHyundaiBydFormat(trimmedData, db)) {
      const partNumber = parsePartNumber(data, db);
      if (partNumber && typeof partNumber === 'object' && partNumber.partial) {
        // partial match — deliver digits and let caller handle
        deliver(partNumber.digits);
        return;
      }
      if (partNumber) {
        lastScanTimeRef.current = now;
        lastScannedDataRef.current = data;
        deliver(partNumber);
        return;
      }
      // parsePartNumber returned null — try direct DB lookup on raw before giving up
      if (db.length > 0) {
        const rawUp = trimmedData.toUpperCase();
        const rawStripped = rawUp.length > 2 ? rawUp.slice(2) : rawUp;
        const dbDirect = db.find(p => {
          const pn = p.partNumber.toUpperCase();
          if (pn === rawUp || pn === rawStripped) return true;
          // One-way fuzzy: raw barcode contains DB part number (safe direction only)
          if (rawUp.length > pn.length && rawUp.includes(pn) && pn.length >= 7) return true;
          if (rawStripped.length > pn.length && rawStripped.includes(pn) && pn.length >= 7) return true;
          return false;
        });
        if (dbDirect) {
          lastScanTimeRef.current = now;
          lastScannedDataRef.current = data;
          deliver(dbDirect.partNumber);
          return;
        }
      }
      // fall through to Isuzu check
    }

    // ===== ISUZU MULTI-BARCODE BUFFER =====
    if (isIsuzuFormat(trimmedData)) {
      let yPosition = 0;
      if (bounds && bounds.origin) {
        yPosition = bounds.origin.y + (bounds.size?.height || 0);
      } else if (cornerPoints && cornerPoints.length > 0) {
        yPosition = Math.max(...cornerPoints.map(p => p.y));
      }

      // Dedup: if same barcode data already in buffer, just update Y if higher
      const existing = isuzuBufferRef.current.find(s => s.data === trimmedData);
      if (existing) {
        if (yPosition > existing.y) existing.y = yPosition;
      } else {
        isuzuBufferRef.current.push({ data: trimmedData, y: yPosition, timestamp: now });
      }

      DEBUG && console.log(`Isuzu buffer add: "${trimmedData}" Y=${yPosition} (${isuzuBufferRef.current.length} in buffer)`);

      if (isuzuTimerRef.current) clearTimeout(isuzuTimerRef.current);
      const hasGM = isuzuBufferRef.current.some(s => s.data.length === 8);
      const hasPart = isuzuBufferRef.current.some(s => s.data.length >= 10);

      if (hasGM && hasPart) {
        // Both barcode types collected — process now
        processIsuzuBuffer();
        return;
      }

      const hasValidMatch = isuzuBufferRef.current.some(s => {
        const norm = normalizeIsuzuPartNumber(s.data);
        return norm && db.some(p => p.partNumber === norm || p.partNumber.replace(/\D/g, '') === norm);
      });
      const timerMs = hasValidMatch ? 200 : ISUZU_BUFFER_MS;
      isuzuTimerRef.current = setTimeout(() => processIsuzuBuffer(), timerMs);
      return;
    }

    // ===== NON-ISUZU: parse normally =====
    const partNumber = parsePartNumber(data, db);

    if (partNumber && typeof partNumber === 'object' && partNumber.partial) {
      // deliver the partial digits — caller can match or ignore
      deliver(partNumber.digits);
      return;
    }

    if (partNumber === null) {
      // Last resort: direct DB lookup on trimmed raw data
      if (db.length > 0) {
        const rawUp = trimmedData.toUpperCase();
        const rawStripped = rawUp.length > 2 ? rawUp.slice(2) : rawUp;
        const dbDirect = db.find(p => {
          const pn = p.partNumber.toUpperCase();
          if (pn === rawUp || pn === rawStripped) return true;
          // One-way fuzzy: raw barcode contains DB part number (safe direction only)
          if (rawUp.length > pn.length && rawUp.includes(pn) && pn.length >= 7) return true;
          if (rawStripped.length > pn.length && rawStripped.includes(pn) && pn.length >= 7) return true;
          return false;
        });
        if (dbDirect) {
          lastScanTimeRef.current = now;
          lastScannedDataRef.current = data;
          deliver(dbDirect.partNumber);
          return;
        }
      }
      return;
    }

    lastScanTimeRef.current = now;
    lastScannedDataRef.current = data;
    deliver(partNumber);
  };

  if (!visible) return null;

  if (!permission?.granted) {
    return (
      <Modal visible animationType="slide">
        <SafeAreaView style={{ flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center", padding: 32 }}>
          <Ionicons name="camera-outline" size={64} color={C.amber} style={{ marginBottom: 20 }} />
          <Text style={{ color: C.t1, fontSize: 22, fontWeight: "800", marginBottom: 10 }}>Camera needed</Text>
          <Text style={{ color: C.t3, fontSize: 16, textAlign: "center", marginBottom: 32 }}>Allow camera access to scan barcodes</Text>
          <TouchableOpacity onPress={requestPermission} style={{ backgroundColor: C.green, borderRadius: 16, padding: 18, width: "100%", alignItems: "center", marginBottom: 12 }}>
            <Text style={{ color: C.bg, fontWeight: "900", fontSize: 18 }}>Allow Camera</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onClose} style={{ padding: 16 }}>
            <Text style={{ color: C.t3, fontSize: 16, letterSpacing: 0.5 }}>Cancel</Text>
          </TouchableOpacity>
        </SafeAreaView>
      </Modal>
    );
  }

  const isPrecount  = title && title.toLowerCase().includes("precount");
  const isFindPart  = title && title.toLowerCase().includes("find");
  const accentColor = isPrecount ? C.orange : isFindPart ? C.blue : C.green;
  const scanIcon    = isPrecount ? "📋" : isFindPart ? "🔍" : "📦";
  const scannerLabel = isPrecount ? "PRECOUNT" : isFindPart ? "PART LOOKUP" : "INVOICE";

  return (
    <Modal visible animationType="slide">
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        <StatusBar barStyle="light-content" backgroundColor="#000" />
        {!keyboardVisible && (
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing="back"
            enableTorch={!!torchEnabled}
            barcodeScannerSettings={{ barcodeTypes: ["code128", "code39", "ean13", "ean8", "qr", "pdf417"] }}
            onBarcodeScanned={scanned || ocrMode ? undefined : handleBarCodeScanned}
          />
        )}

        {/* Top colour strip */}
        <View style={{ position: "absolute", top: 0, left: 0, right: 0 }}>
          <View style={{ backgroundColor: accentColor, paddingTop: 48, paddingBottom: 18, paddingHorizontal: 24, flexDirection: "row", alignItems: "center", gap: 14 }}>
            <Text style={{ fontSize: 28 }}>{scanIcon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ color: "#00000088", fontSize: 10, fontWeight: "900", letterSpacing: 3 }}>{scannerLabel}</Text>
              <Text style={{ color: "#000", fontSize: 20, fontWeight: "900", letterSpacing: 0.3 }}>{title || "Scan Barcode"}</Text>
            </View>
          </View>
        </View>

        {/* Bottom panel — premium slim */}
        <View style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}>
          <View style={{ height: 2, backgroundColor: accentColor }} />
          <View style={{ backgroundColor: "#000000F2", paddingTop: 20, paddingBottom: 32, paddingHorizontal: 28, alignItems: "center" }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: accentColor + "18", borderRadius: 20, paddingHorizontal: 18, paddingVertical: 8, borderWidth: 1, borderColor: accentColor + "44", marginBottom: 18 }}>
              <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: accentColor }} />
              <Text style={{ color: accentColor, fontSize: 12, fontWeight: "900", letterSpacing: 1.5 }}>READY TO SCAN</Text>
              <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: accentColor }} />
            </View>
            <TouchableOpacity
              onPress={onClose}
              style={{ backgroundColor: "#1A1A1A", borderRadius: 16, paddingHorizontal: 48, paddingVertical: 16, borderWidth: 1.5, borderColor: accentColor + "44" }}
              activeOpacity={0.7}
            >
              <Text style={{ color: C.t1, fontSize: 16, fontWeight: "700", letterSpacing: 0.5 }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Bottom-left: keyboard manual entry */}
        {/* Bottom-left: keyboard */}
        <TouchableOpacity
          onPress={() => { if (onInvoiceKeyboard) { onInvoiceKeyboard(); } else { setOcrMode(false); setKeyboardInput(""); setKeyboardVisible(true); } }}
          activeOpacity={0.8}
          style={{ position: "absolute", bottom: 220, left: 20, backgroundColor: "#000000CC", borderRadius: 18, padding: 18, borderWidth: 1.5, borderColor: accentColor + "66", width: 64, height: 64, alignItems: "center", justifyContent: "center" }}
        >
          <MaterialCommunityIcons name="keyboard-outline" size={28} color={accentColor} />
        </TouchableOpacity>

        {/* Bottom-right: OCR toggle */}
        <TouchableOpacity
          onPress={() => setOcrMode(v => !v)}
          activeOpacity={0.8}
          style={{ position: "absolute", bottom: 220, right: 20, backgroundColor: ocrMode ? accentColor + "33" : "#000000CC", borderRadius: 18, borderWidth: 1.5, borderColor: accentColor + "66", width: 64, height: 64, alignItems: "center", justifyContent: "center" }}
        >
          <Text style={{ color: accentColor, fontSize: 15, fontWeight: "900", letterSpacing: 1 }}>OCR</Text>
        </TouchableOpacity>

        {/* OCR capture button — appears when ocrMode is on */}
        {ocrMode && (
          <TouchableOpacity
            onPress={async () => {
              if (ocrProcessing || !cameraRef.current) return;
              setOcrProcessing(true);
              try {
                const photo = await cameraRef.current.takePictureAsync({ base64: false, quality: 0.8 });
                const imgW = photo.width || 1080, imgH = photo.height || 1920;
                const cropH = Math.round(imgH * 0.4), cropY = Math.round((imgH - cropH) / 2);
                let base64Data;
                try {
                  const cropped = await ImageManipulator.manipulateAsync(photo.uri, [{ crop: { originX: 0, originY: cropY, width: imgW, height: cropH } }], { base64: true, compress: 0.85, format: ImageManipulator.SaveFormat.JPEG });
                  base64Data = cropped.base64;
                } catch {
                  const fallback = await ImageManipulator.manipulateAsync(photo.uri, [], { base64: true, compress: 0.85, format: ImageManipulator.SaveFormat.JPEG });
                  base64Data = fallback.base64;
                }
                const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${VISION_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requests: [{ image: { content: base64Data }, features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }] }] }) });
                const json = await res.json();
                const annotation = json.responses?.[0]?.fullTextAnnotation;
                const text = annotation?.text || "";
                const wordData = extractWordLevelData(annotation);
                const found = extractPartNumbersFromOCR(text, partsDB || [], wordData);
                if (found.length > 0) { Vibration.vibrate(80); setOcrMode(false); deliver(found[0]); }
                else { Alert.alert("No Part Found", "Could not read a part number.\nTry better lighting or the keyboard."); }
              } catch (e) { Alert.alert("OCR Error", e.message || "Failed"); }
              setOcrProcessing(false);
            }}
            activeOpacity={0.85}
            style={{ position: "absolute", bottom: 210, left: 100, right: 100, backgroundColor: accentColor, borderRadius: 20, height: 64, alignItems: "center", justifyContent: "center", borderWidth: 3, borderColor: "#000" }}
          >
            {ocrProcessing
              ? <MaterialCommunityIcons name="loading" size={28} color="#000" />
              : <MaterialCommunityIcons name="camera" size={32} color="#000" />}
          </TouchableOpacity>
        )}

        {/* Keyboard input modal */}
        <Modal visible={keyboardVisible} transparent animationType="fade">
          <TouchableOpacity style={{ flex: 1, backgroundColor: "#00000088" }} activeOpacity={1} onPress={() => setKeyboardVisible(false)} />
          <View style={{ backgroundColor: C.s1, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 48 }}>
            <View style={{ alignSelf: "center", width: 40, height: 4, backgroundColor: C.b1, borderRadius: 2, marginBottom: 20 }} />
            <Text style={{ color: C.t2, fontSize: 12, fontWeight: "900", letterSpacing: 1.5, marginBottom: 8 }}>PART OR ORDER NUMBER LOOKUP</Text>
            <TextInput
              ref={keyboardInputRef}
              value={keyboardInput}
              onChangeText={setKeyboardInput}
              placeholder="Part number or order number…"
              placeholderTextColor={C.t3}
              autoCapitalize="characters"
              returnKeyType="done"
              onSubmitEditing={() => {
                const val = keyboardInput.trim().toUpperCase();
                if (val.length > 0) { setKeyboardVisible(false); deliver(val); }
              }}
              style={{ backgroundColor: C.s2, borderRadius: 14, padding: 18, color: C.t1, fontSize: 20, fontWeight: "900", borderWidth: 1.5, borderColor: accentColor + "66", letterSpacing: 1, marginBottom: 14 }}
            />
            <TouchableOpacity
              onPress={() => {
                const val = keyboardInput.trim().toUpperCase();
                if (val.length > 0) { setKeyboardVisible(false); deliver(val); }
              }}
              style={{ backgroundColor: accentColor, borderRadius: 16, paddingVertical: 18, alignItems: "center" }}
              activeOpacity={0.85}
            >
              <Text style={{ color: C.bg, fontSize: 18, fontWeight: "900" }}>Confirm</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setKeyboardVisible(false); if (initialKeyboard) onClose(); }} style={{ paddingVertical: 14, alignItems: "center" }}>
              <Text style={{ color: C.t3, fontSize: 15 }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </Modal>

      </View>
    </Modal>
  );
}
// ─── KIA RECEIVING ────────────────────────────────────────────────────────────

function parseKiaCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map(h => h.replace(/"/g, "").replace(/:STRING\(\d+\)/gi, "").trim());
  const idx  = n => header.findIndex(h => h.toLowerCase() === n.toLowerCase());
  const idxP = n => header.findIndex(h => h.toLowerCase().includes(n.toLowerCase()));
  const iInv   = idx("Inv. No.")   >= 0 ? idx("Inv. No.")   : idxP("inv");
  const iOrder = idx("Dealer Order No") >= 0 ? idx("Dealer Order No")
               : idx("Order No")   >= 0 ? idx("Order No")
               : idx("PO Number")  >= 0 ? idx("PO Number")
               : idxP("order")     >= 0 ? idxP("order") : 5;
  const iPart  = idx("Unformatted - item supplied") >= 0 ? idx("Unformatted - item supplied") : idxP("item supplied");
  const iDesc  = idx("Item Description") >= 0 ? idx("Item Description") : idxP("description");
  const iQty   = idx("Quantity Supplied") >= 0 ? idx("Quantity Supplied") : idxP("quantity");
  const iLines = idx("# of Inv Lines") >= 0 ? idx("# of Inv Lines") : idxP("inv lines");
  const iLine  = idx("Order Line No") >= 0 ? idx("Order Line No") : idxP("line no");
  const iDate  = idx("Inv. Date") >= 0 ? idx("Inv. Date") : idxP("inv. date");
  const iClose = idx("Close Date") >= 0 ? idx("Close Date") : idx("CLOSDATE") >= 0 ? idx("CLOSDATE") : idxP("close");
  const parseInvDate = (s) => {
    if (!s) return 0;
    // DD/MM/YYYY
    const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return new Date(`${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`).getTime();
    return 0;
  };
  const invoiceMap = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].replace(/\r/g, "").split(",").map(c => c.replace(/"/g, "").trim());
    const inv  = cols[iInv  >= 0 ? iInv  : 2]  || "";
    const part = cols[iPart >= 0 ? iPart : 13] || "";
    if (!inv || !part) continue;
    if (!invoiceMap[inv]) {
      invoiceMap[inv] = {
        id:         inv,
        orderRef:   cols[iOrder >= 0 ? iOrder : 5] || "",
        totalLines: parseInt(cols[iLines >= 0 ? iLines : 10]) || 0,
        parts:      [],
        complete:   false,
        importedAt: Date.now(),
        invDate:    parseInvDate(cols[iDate >= 0 ? iDate : 3] || ""),
        closedInDMS: iClose >= 0 ? (cols[iClose] || "").trim() !== "" : false,
      };
    }
    if (!invoiceMap[inv].parts.find(p => p.partNumber === part && p.lineNo === cols[iLine >= 0 ? iLine : 16])) {
      invoiceMap[inv].parts.push({
        partNumber:  part,
        description: cols[iDesc >= 0 ? iDesc : 14] || "",
        qty:         parseInt(cols[iQty >= 0 ? iQty : 15]) || 1,
        lineNo:      cols[iLine >= 0 ? iLine : 16] || "",
        confirmed:   0,
        short:       false,
        shortQty:    null,
      });
    }
  }
  return Object.values(invoiceMap);
}

// ─── DISPATCH CSV PARSER ─────────────────────────────────────────────────────
function parseDispatchCSVLine(line) {
  const result = []; let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; }
    else if (ch === "," && !inQ) { result.push(cur); cur = ""; }
    else { cur += ch; }
  }
  result.push(cur);
  return result;
}

function parseDispatchCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map(h => h.replace(/"/g,"").trim().toUpperCase());
  const idx = n => header.findIndex(h => h === n);
  const iInv = idx("INV#"), iPart = idx("PART#"), iCust = idx("CNAME");
  const iReq = idx("REQDATE"), iClos = idx("CLOSDATE");
  const iQord = idx("QORD"), iQshp = idx("QSHP"), iDesc = idx("PART_DESC_20"), iComment = idx("COMMENTS");
  const invoiceMap = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = parseDispatchCSVLine(lines[i].replace(/\r/g,""));
    const inv  = cols[iInv  >= 0 ? iInv  : 0]?.replace(/"/g,"").trim();
    const part = cols[iPart >= 0 ? iPart : 5]?.replace(/"/g,"").trim();
    if (!inv || !part) continue;
    const cleanPart = String(part).slice(2);
    const qord = parseInt(cols[iQord >= 0 ? iQord : 6]) || 1;
    const qshp = parseInt(cols[iQshp >= 0 ? iQshp : 7]) || 0;
    if (!invoiceMap[inv]) {
      const clos = cols[iClos >= 0 ? iClos : 4]?.replace(/"/g,"").trim() || "";
      invoiceMap[inv] = {
        id: inv,
        customer: cols[iCust >= 0 ? iCust : 1]?.replace(/"/g,"").trim() || "Unknown",
        reqDate:  cols[iReq  >= 0 ? iReq  : 3]?.replace(/"/g,"").trim() || "",
        parts: [],
        locked: false,
        precounted: false,
        closedInDMS: clos !== "",
      };
    }
    if (!invoiceMap[inv].parts.find(p => p.partNumber === cleanPart)) {
      const desc = cols[iDesc >= 0 ? iDesc : -1]?.replace(/"/g,"").trim() || "";
      const comment = cols[iComment >= 0 ? iComment : -1]?.replace(/"/g,"").trim() || "";
      invoiceMap[inv].parts.push({ partNumber: cleanPart, description: desc, comment, expected: qord, qshp, backorder: qshp < qord, loaded: 0, delivered: 0, precounted: 0 });
    }
  }
  return Object.values(invoiceMap);
}

// ─── DISPATCH PRECOUNT SCREEN ─────────────────────────────────────────────────
function DispatchPreCountScreen({ invoice, onBack, onComplete, setDispatchInvoices, torchEnabled, hideBackorderCol, setHideBackorderCol }) {
  const [showScanner, setShowScanner]   = useState(false);
  const [scanPopup, setScanPopup]       = useState(null);
  const [noteModal, setNoteModal]       = useState(null);
  const noteInputRef = useRef(null);
  const [noteText, setNoteText]         = useState("");
  const [qtyModal, setQtyModal]         = useState(null);
  const [qtyInput, setQtyInput]         = useState("");
  const [overrideModal, setOverrideModal] = useState(null);
  const [lastScanned, setLastScanned]   = useState(null);
  const insets = useSafeAreaInsets();

  const activeParts    = invoice.parts.filter(p => !p.backorder);
  const backorderParts = invoice.parts.filter(p => p.backorder);

  // Auto-show/hide backorder column based on whether invoice has any backorders
  useEffect(() => {
    const hasBackorders = invoice.parts.some(p => p.backorder);
    setHideBackorderCol(!hasBackorders);
  }, [invoice.id]);
  const confirmedCount = activeParts.filter(p => (p.precounted || 0) >= p.expected).length;
  const allDone        = confirmedCount === activeParts.length && activeParts.length > 0;
  const pendingParts   = activeParts.filter(p => (p.precounted || 0) < p.expected);
  const confirmedParts = activeParts
    .filter(p => (p.precounted || 0) >= p.expected)
    .sort((a, b) => (b.precountedAt || 0) > (a.precountedAt || 0) ? 1 : -1);

  const showScanPopup = (icon, label, color) => {
    setScanPopup({ icon, label, color });
    setTimeout(() => setScanPopup(null), 900);
  };

  const applyPrecount = (idx, qty) => {
    const clamped = Math.min(Math.max(1, qty), invoice.parts[idx].expected);
    Vibration.vibrate(60);
    setDispatchInvoices(prev => prev.map(inv => {
      if (inv.id !== invoice.id) return inv;
      return { ...inv, parts: inv.parts.map((p, i) => i !== idx ? p : { ...p, precounted: clamped, precountedAt: Date.now() }) };
    }));
    showScanPopup("✓", `Qty ${clamped}`, C.green);
    setQtyModal(null); setQtyInput("");
  };

  const [flashPartNumber, setFlashPartNumber] = useState(null);

  const handlePartScanned = (data) => {
    setShowScanner(false);
    const scanned = String(data).trim();
    const stripped = scanned.length > 2 ? scanned.slice(2) : scanned;
    const dashStripped = scanned.replace(/-[A-Z0-9]{1,5}$/, '');
    const dashStrippedShort = stripped.replace(/-[A-Z0-9]{1,5}$/, '');
    const idx = invoice.parts.findIndex(p =>
      p.partNumber === scanned || p.partNumber === stripped ||
      p.partNumber === dashStripped || p.partNumber === dashStrippedShort ||
      p.partNumber === scanned.toUpperCase() || p.partNumber === stripped.toUpperCase()
    );
    if (idx === -1) { Vibration.vibrate([0,80,80,80]); showScanPopup("✕","NOT FOUND",C.red); setLastScanned({ partNumber: scanned, status: "not_found" }); return; }
    const part = invoice.parts[idx];
    if (part.backorder) { showScanPopup("!","BACKORDER",C.amber); setLastScanned({ partNumber: part.partNumber, status: "backorder" }); return; }
    if ((part.precounted || 0) >= part.expected) {
      showScanPopup("✓","ALREADY DONE",C.amber);
      setLastScanned({ partNumber: part.partNumber, lineNo: part.lineNo, status: "already_done" });
      // After popup disappears, bump precountedAt to sort it to top and flash it
      setTimeout(() => {
        setDispatchInvoices(prev => prev.map(inv => {
          if (inv.id !== invoice.id) return inv;
          return { ...inv, parts: inv.parts.map((p, i) => i !== idx ? p : { ...p, precountedAt: Date.now() }) };
        }));
        setFlashPartNumber(part.partNumber);
        setTimeout(() => setFlashPartNumber(null), 1000);
      }, 950);
      return;
    }
    if (part.expected > 1) { setQtyModal({ idx, partNumber: part.partNumber, expected: part.expected }); setQtyInput(""); setLastScanned({ partNumber: part.partNumber, lineNo: part.lineNo, status: "qty_needed" }); return; }
    Vibration.vibrate(60);
    setDispatchInvoices(prev => prev.map(inv => {
      if (inv.id !== invoice.id) return inv;
      return { ...inv, parts: inv.parts.map((p, i) => i !== idx ? p : { ...p, precounted: (p.precounted || 0) + 1, precountedAt: Date.now() }) };
    }));
    setLastScanned({ partNumber: part.partNumber, lineNo: part.lineNo, status: "ok" });
    showScanPopup("✓","CONFIRMED",C.green);
  };

  const handleComplete = () => {
    setDispatchInvoices(prev => prev.map(inv => inv.id === invoice.id ? { ...inv, precounted: true, precountedAt: new Date().toISOString() } : inv));
    onComplete();
  };

  const handleManualConfirm = () => {
    if (!overrideModal) return;
    const { idx, expected } = overrideModal;
    setOverrideModal(null);
    if (expected > 1) {
      setQtyModal({ idx, partNumber: overrideModal.partNumber, expected });
      setQtyInput("");
    } else {
      Vibration.vibrate(60);
      setDispatchInvoices(prev => prev.map(inv => {
        if (inv.id !== invoice.id) return inv;
        return { ...inv, parts: inv.parts.map((p, i) => i !== idx ? p : { ...p, precounted: p.expected, precountedAt: Date.now() }) };
      }));
    }
  };

  const handleUndoConfirm = () => {
    if (!overrideModal) return;
    const { idx } = overrideModal;
    setOverrideModal(null);
    setDispatchInvoices(prev => prev.map(inv => {
      if (inv.id !== invoice.id) return inv;
      return { ...inv, parts: inv.parts.map((p, i) => i !== idx ? p : { ...p, precounted: 0 }) };
    }));
  };

  const lastScanColor = lastScanned ? (lastScanned.status === "ok" ? C.green : lastScanned.status === "not_found" ? C.red : C.amber) : C.t3;

  const renderCard = (part, colColor) => {
    const realIdx = invoice.parts.indexOf(part);
    const qty = part.precounted || 0;
    const done = qty >= part.expected;
    return (
      <TouchableOpacity key={part.partNumber + realIdx} activeOpacity={0.75}
        onPress={() => { Vibration.vibrate(40); setOverrideModal({ idx: realIdx, partNumber: part.partNumber, expected: part.expected, done }); }}
        style={{ backgroundColor: flashPartNumber === part.partNumber ? C.amber + "33" : C.s2, borderRadius: 10, borderLeftWidth: 3, borderLeftColor: colColor, borderTopWidth: 0, borderRightWidth: 0, borderBottomWidth: 0, padding: 12, marginBottom: 8 }}>
        <Text style={{ color: C.t1, fontSize: 18, fontWeight: "900", marginBottom: 3 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>{part.partNumber}</Text>
        {part.description ? <Text style={{ color: C.t2, fontSize: 11, marginBottom: 4 }} numberOfLines={1}>{part.description}</Text> : null}
        <Text style={{ color: colColor, fontSize: 11, fontWeight: "700" }}>{qty}/{part.expected} parts</Text>
        {part.precountNote ? <Text style={{ color: C.amber, fontSize: 10, marginTop: 2 }}>note: {part.precountNote}</Text> : null}
      </TouchableOpacity>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 16, paddingBottom: 12, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: 1, borderBottomColor: C.b1, backgroundColor: C.s2 }}>
        <TouchableOpacity onPress={onBack} activeOpacity={0.7} style={{ backgroundColor: C.s3, borderRadius: 10, padding: 8, borderWidth: 1, borderColor: C.b1 }}>
          <Ionicons name="arrow-back" size={20} color={C.t2} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={{ color: C.t1, fontSize: 18, fontWeight: "900" }}>Picking Slip</Text>
        </View>
        <TouchableOpacity onPress={() => { Alert.alert("Reset?","Clear all confirmed quantities?",[{text:"Cancel",style:"cancel"},{text:"Reset",style:"destructive",onPress:()=>{setDispatchInvoices(prev=>prev.map(inv=>inv.id!==invoice.id?inv:{...inv,parts:inv.parts.map(p=>({...p,precounted:0}))}));setLastScanned(null);}}]); }}
          style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: C.s3, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: C.b1 }} activeOpacity={0.6}>
          <MaterialCommunityIcons name="refresh" size={18} color={C.t3} />
        </TouchableOpacity>
      </View>

      {/* Banner — E1 */}
      <View style={{ backgroundColor: C.s1, marginHorizontal: 10, marginTop: 8, marginBottom: 4, borderRadius: 14, borderWidth: 1, borderColor: C.b1, overflow: "hidden" }}>
        <View style={{ padding: 14, paddingBottom: 12 }}>
          <Text style={{ color: C.t3, fontSize: 9, fontWeight: "900", letterSpacing: 2, marginBottom: 5 }}>PANEL SHOP</Text>
          <Text style={{ color: C.t1, fontSize: 28, fontWeight: "900", lineHeight: 32 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>{invoice.customer}</Text>
        </View>
        <View style={{ height: 1, backgroundColor: C.b1 }} />
        <View style={{ paddingHorizontal: 16, paddingVertical: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View>
            <Text style={{ color: C.t3, fontSize: 9, fontWeight: "900", letterSpacing: 2, marginBottom: 2 }}>INVOICE</Text>
            <Text style={{ color: C.t1, fontSize: 36, fontWeight: "900", lineHeight: 36, letterSpacing: -1 }}>{invoice.id}</Text>
          </View>
          {invoice.reqDate ? (
            <View style={{ backgroundColor: C.amber + "18", borderWidth: 1, borderColor: C.amber + "55", borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12, alignItems: "center" }}>
              <Text style={{ color: C.t3, fontSize: 8, fontWeight: "900", letterSpacing: 1, marginBottom: 2 }}>REQ DATE</Text>
              <Text style={{ color: C.amber, fontSize: 13, fontWeight: "900" }}>{invoice.reqDate}</Text>
            </View>
          ) : null}
        </View>
        <View style={{ height: 1, backgroundColor: C.b1 }} />
        <View style={{ paddingHorizontal: 16, paddingVertical: 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ color: C.t3, fontSize: 9, fontWeight: "900", letterSpacing: 1.5 }}>LAST SCAN</Text>
          {lastScanned
            ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ color: lastScanColor, fontSize: 11, fontWeight: "900" }}>{lastScanned.partNumber}</Text>
                <View style={{ backgroundColor: lastScanColor, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
                  <Text style={{ color: C.bg, fontSize: 9, fontWeight: "900" }}>{lastScanned.status === "ok" ? "✓ OK" : lastScanned.status === "not_found" ? "✕ NOT FOUND" : "DONE"}</Text>
                </View>
              </View>
            : <Text style={{ color: C.b1, fontSize: 18, fontWeight: "900" }}>—</Text>}
        </View>
      </View>

      {/* Kanban headers */}
      <View style={{ flexDirection: "row", marginHorizontal: 10, backgroundColor: C.bg, gap: 1 }}>
        <TouchableOpacity
          onPress={() => setHideBackorderCol && setHideBackorderCol(v => !v)}
          activeOpacity={0.7}
          style={{ width: hideBackorderCol ? 36 : undefined, flex: hideBackorderCol ? undefined : 1, borderTopWidth: 3, borderTopColor: "#AB47BC", paddingTop: 6, paddingBottom: 6, paddingHorizontal: 6, flexDirection: hideBackorderCol ? "column" : "row", alignItems: "center", justifyContent: "space-between", backgroundColor: C.bg }}>
          {hideBackorderCol ? (
            <>
              <Text style={{ color: C.t3, fontSize: 8, fontWeight: "900", letterSpacing: 0.5 }}>B/O</Text>
              <Text style={{ color: C.t3, fontSize: 9, fontWeight: "900", marginTop: 2 }}>{backorderParts.length}</Text>
            </>
          ) : (
            <>
              <Text style={{ color: C.t3, fontSize: 9, fontWeight: "900", letterSpacing: 1 }}>B/ORDER</Text>
              <Text style={{ color: C.t3, fontSize: 9, fontWeight: "900" }}>{backorderParts.length}</Text>
            </>
          )}
        </TouchableOpacity>
        <View style={{ flex: 1, borderTopWidth: 3, borderTopColor: C.red, paddingTop: 6, paddingBottom: 6, paddingHorizontal: 6, flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: C.bg }}>
          <Text style={{ color: C.t3, fontSize: 9, fontWeight: "900", letterSpacing: 1 }}>PENDING</Text>
          <Text style={{ color: C.t3, fontSize: 9, fontWeight: "900" }}>{pendingParts.length}</Text>
        </View>
        <View style={{ flex: 1, borderTopWidth: 3, borderTopColor: C.green, paddingTop: 6, paddingBottom: 6, paddingHorizontal: 6, flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: C.bg }}>
          <Text style={{ color: C.t3, fontSize: 9, fontWeight: "900", letterSpacing: 1 }}>CONFIRMED</Text>
          <Text style={{ color: C.t3, fontSize: 9, fontWeight: "900" }}>{confirmedParts.length}</Text>
        </View>
      </View>

      {/* Kanban body */}
      <View style={{ flex: 1, flexDirection: "row", marginHorizontal: 10, gap: 1, backgroundColor: C.bg }}>
        {!hideBackorderCol && (
          <TouchableOpacity
            onPress={() => setHideBackorderCol && setHideBackorderCol(true)}
            activeOpacity={1}
            style={{ flex: 1 }}>
            <ScrollView contentContainerStyle={{ padding: 6, paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
              {backorderParts.map((part, i) => (
                <View key={part.partNumber+i} style={{ backgroundColor: C.s2, borderRadius: 10, borderLeftWidth: 3, borderLeftColor: "#AB47BC", borderTopWidth: 0, borderRightWidth: 0, borderBottomWidth: 0, padding: 10, marginBottom: 6 }}>
                  <Text style={{ color: "#CE93D8", fontSize: 12, fontWeight: "900" }} numberOfLines={1}>{part.partNumber}</Text>
                  {part.description ? <Text style={{ color: C.t2, fontSize: 10 }} numberOfLines={1}>{part.description}</Text> : null}
                  <View style={{ flexDirection: "row", gap: 6, marginTop: 4 }}>
                    <Text style={{ color: "#AB47BC", fontSize: 10, fontWeight: "700" }}>Ord:{part.expected}</Text>
                    <Text style={{ color: "#AB47BC", fontSize: 10, fontWeight: "700" }}>Shp:{part.qshp||0}</Text>
                  </View>
                </View>
              ))}
            </ScrollView>
          </TouchableOpacity>
        )}
        {hideBackorderCol && (
          <TouchableOpacity
            onPress={() => setHideBackorderCol && setHideBackorderCol(false)}
            activeOpacity={0.6}
            style={{ width: 36 }}
          />
        )}
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 6, paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
          {pendingParts.map(part => renderCard(part, C.red))}
        </ScrollView>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 6, paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
          {confirmedParts.map(part => renderCard(part, C.green))}
        </ScrollView>
      </View>

      {/* Bottom bar */}
      <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: 16, paddingBottom: Math.max(insets.bottom, 16), backgroundColor: C.bg, borderTopWidth: 1, borderTopColor: C.b1, flexDirection: "row", gap: 10 }}>
        {allDone
          ? <TouchableOpacity onPress={handleComplete} activeOpacity={0.85} style={{ flex: 1, backgroundColor: C.green, borderRadius: 18, paddingVertical: 24, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 12 }}>
              <MaterialCommunityIcons name="check-circle-outline" size={34} color={C.bg} />
              <Text style={{ color: C.bg, fontSize: 22, fontWeight: "900" }}>PRECOUNT COMPLETE ✓</Text>
            </TouchableOpacity>
          : <TouchableOpacity onPress={() => setShowScanner(true)} activeOpacity={0.85} style={{ flex: 1, backgroundColor: C.green, borderRadius: 18, paddingVertical: 24, alignItems: "center", justifyContent: "center" }}>
              <MaterialCommunityIcons name="barcode-scan" size={34} color={C.bg} />
            </TouchableOpacity>
        }
      </View>

      {/* Override modal */}
      <Modal visible={!!overrideModal} transparent animationType="slide">
        <TouchableOpacity style={{ flex: 1, backgroundColor: "#00000088", justifyContent: "flex-end" }} activeOpacity={1} onPress={() => setOverrideModal(null)}>
          <View style={{ backgroundColor: C.s1, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 28 }}>
            <View style={{ alignSelf: "center", width: 40, height: 4, backgroundColor: C.b1, borderRadius: 2, marginBottom: 20 }} />
            <Text style={{ color: C.t2, fontSize: 12, fontWeight: "700", letterSpacing: 1, marginBottom: 4 }}>OVERRIDE</Text>
            <Text style={{ color: C.t1, fontSize: 18, fontWeight: "900", marginBottom: 20 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.4}>{overrideModal?.partNumber}</Text>
            <TouchableOpacity onPress={handleManualConfirm} activeOpacity={0.8}
              style={{ backgroundColor: C.green+"22", borderRadius: 14, padding: 18, marginBottom: 10, flexDirection: "row", alignItems: "center", gap: 14, borderWidth: 1.5, borderColor: C.green+"66" }}>
              <MaterialCommunityIcons name="check-bold" size={24} color={C.green} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: C.green, fontSize: 16, fontWeight: "900" }}>Manual Confirm</Text>
                <Text style={{ color: C.t3, fontSize: 12, marginTop: 2 }}>Mark as counted without scanning</Text>
              </View>
            </TouchableOpacity>
            {overrideModal?.done && (
              <TouchableOpacity onPress={handleUndoConfirm} activeOpacity={0.8}
                style={{ backgroundColor: C.amber+"22", borderRadius: 14, padding: 18, marginBottom: 10, flexDirection: "row", alignItems: "center", gap: 14, borderWidth: 1.5, borderColor: C.amber+"66" }}>
                <MaterialCommunityIcons name="undo" size={24} color={C.amber} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: C.amber, fontSize: 16, fontWeight: "900" }}>Undo / Reset</Text>
                  <Text style={{ color: C.t3, fontSize: 12, marginTop: 2 }}>Mark back as not counted</Text>
                </View>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => { const {idx,partNumber}=overrideModal; setOverrideModal(null); setNoteModal({idx,partNumber}); setNoteText(invoice.parts[idx]?.precountNote||""); }} activeOpacity={0.8}
              style={{ backgroundColor: C.s2, borderRadius: 14, padding: 18, marginBottom: 10, flexDirection: "row", alignItems: "center", gap: 14, borderWidth: 1.5, borderColor: C.b1 }}>
              <MaterialCommunityIcons name="pencil-outline" size={24} color={C.t2} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: C.t1, fontSize: 16, fontWeight: "900" }}>Add / Edit Note</Text>
                <Text style={{ color: C.t3, fontSize: 12, marginTop: 2 }}>e.g. short 1, damaged, wrong part</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setOverrideModal(null)} style={{ padding: 14, alignItems: "center" }}>
              <Text style={{ color: C.t3, fontSize: 16 }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Note modal */}
      <Modal visible={!!noteModal} transparent animationType="slide" onShow={() => setTimeout(() => noteInputRef.current?.focus(), 100)}>
        <TouchableOpacity style={{ flex: 1, backgroundColor: "#00000088", justifyContent: "flex-end" }} activeOpacity={1} onPress={() => { setNoteModal(null); setNoteText(""); }}>
          <View style={{ backgroundColor: C.s1, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 28 }}>
            <View style={{ alignSelf: "center", width: 40, height: 4, backgroundColor: C.b1, borderRadius: 2, marginBottom: 20 }} />
            <Text style={{ color: C.green, fontSize: 16, fontWeight: "900", marginBottom: 4 }}>Add Note</Text>
            <Text style={{ color: C.t3, fontSize: 13, marginBottom: 16 }}>{noteModal?.partNumber}</Text>
            <TextInput ref={noteInputRef} style={{ backgroundColor: C.s2, borderRadius: 14, borderWidth: 1, borderColor: C.green+"66", color: C.t1, fontSize: 16, padding: 16, marginBottom: 16, minHeight: 80, textAlignVertical: "top" }}
              placeholder="e.g. short 1, damaged..." placeholderTextColor={C.t3} value={noteText} onChangeText={setNoteText} multiline />
            <TouchableOpacity onPress={() => { if(!noteModal)return; setDispatchInvoices(prev=>prev.map(inv=>{if(inv.id!==invoice.id)return inv;return{...inv,parts:inv.parts.map((p,i)=>i!==noteModal.idx?p:{...p,precountNote:noteText.trim()})}})); setNoteModal(null); setNoteText(""); }}
              style={{ backgroundColor: C.green, borderRadius: 14, padding: 18, alignItems: "center", marginBottom: 12 }}>
              <Text style={{ color: C.bg, fontSize: 18, fontWeight: "900" }}>Save Note</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setNoteModal(null); setNoteText(""); }} style={{ padding: 14, alignItems: "center" }}>
              <Text style={{ color: C.t3, fontSize: 16 }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Qty pad */}
      <Modal visible={!!qtyModal} transparent animationType="slide">
        <TouchableOpacity style={{ flex: 1, backgroundColor: "#00000088", justifyContent: "flex-end" }} activeOpacity={1} onPress={() => { setQtyModal(null); setQtyInput(""); }}>
          <View style={{ backgroundColor: C.s1, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 48 }}>
            <View style={{ alignSelf: "center", width: 40, height: 4, backgroundColor: C.b1, borderRadius: 2, marginBottom: 20 }} />
            <Text style={{ color: C.t1, fontSize: 18, fontWeight: "900", marginBottom: 4 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.4}>{qtyModal?.partNumber}</Text>
            <Text style={{ color: C.t3, fontSize: 13, marginBottom: 20 }}>Expected: {qtyModal?.expected}</Text>
            <View style={{ backgroundColor: C.s2, borderRadius: 16, borderWidth: 2, borderColor: C.green+"66", padding: 20, alignItems: "center", marginBottom: 16 }}>
              <Text style={{ color: C.t3, fontSize: 12, fontWeight: "700", marginBottom: 4 }}>CONFIRMING QTY</Text>
              <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 4 }}>
                <Text style={{ color: C.green, fontSize: 52, fontWeight: "900" }}>{qtyInput || "0"}</Text>
                <Text style={{ color: C.t3, fontSize: 32, fontWeight: "700", marginBottom: 6 }}>/{qtyModal?.expected}</Text>
              </View>
            </View>
            {[["1","2","3"],["4","5","6"],["7","8","9"],["⌫","0","✓"]].map((row, ri) => (
              <View key={ri} style={{ flexDirection: "row", gap: 10, marginBottom: 10 }}>
                {row.map(key => {
                  const isC = key==="✓"; const isB = key==="⌫";
                  return <TouchableOpacity key={key} activeOpacity={0.7} onPress={() => { if(isC){const n=parseInt(qtyInput)||0;if(n>0&&qtyModal)applyPrecount(qtyModal.idx,n);}else if(isB){setQtyInput(q=>q.slice(0,-1));}else{setQtyInput(q=>q.length>=3?q:q+key);} }}
                    style={{ flex:1, paddingVertical:20, borderRadius:14, alignItems:"center", justifyContent:"center", backgroundColor:isC?C.green:isB?C.s3:C.s2, borderWidth:1.5, borderColor:isC?C.green:C.b1 }}>
                    <Text style={{ color:isC?C.bg:C.t1, fontSize:24, fontWeight:"800" }}>{key}</Text>
                  </TouchableOpacity>;
                })}
              </View>
            ))}
            <TouchableOpacity onPress={() => { setQtyModal(null); setQtyInput(""); }} style={{ padding: 14, alignItems: "center" }}>
              <Text style={{ color: C.t3, fontSize: 16 }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <BarcodeScanner visible={showScanner} title="Scan Part — Precount" onScanned={handlePartScanned} onClose={() => setShowScanner(false)} partsDB={invoice.parts.map(p => ({ partNumber: p.partNumber }))} torchEnabled={torchEnabled} />

      {scanPopup && (
        <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", backgroundColor: "#00000066" }}>
          <View style={{ width: 200, height: 200, borderRadius: 100, backgroundColor: scanPopup.color, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: "#fff", fontSize: 72, fontWeight: "900" }}>{scanPopup.icon}</Text>
            <Text style={{ color: "#fff", fontSize: 20, fontWeight: "900", marginTop: 4 }}>{scanPopup.label}</Text>
          </View>
        </View>
      )}
    </View>
  );
}

// ─── KIA HOME SCREEN ──────────────────────────────────────────────────────────
function KiaHomeScreen({ invoices, onImportCSV, onFetchFromServer, onClearAll, onOpenList, onFindPart, onManualInvoice, torchEnabled, setTorchEnabled, onScanFindPart, appMode, setAppMode, kiaPartResult, setKiaPartResult, onOpenInvoice, focusList, onOpenBoard, setFocusList, onAddToPending, wsStatus, wsLastSync, onSilentSync, onDispatchSync, hideOrderRefs, setHideOrderRefs, suppressNewInvAlert, setSuppressNewInvAlert, dimOtherCards, setDimOtherCards, onExportEmail, hideFindBtn, setHideFindBtn, onFindPartLookup, partLookupResult, setPartLookupResult, hideClosedInvoices, setHideClosedInvoices, onOpenDispatchPrecount, hideBackorderColProp, setHideBackorderColProp, activeBoards, userIdentity, wsRef, currentRoomId, onRequestJoin }) {
  const [showManual, setShowManual]         = useState(false);
  const [manualText, setManualText]         = useState("");
  const [settingsMenu, setSettingsMenu]     = useState(false);
  const [refreshing, setRefreshing]         = useState(false);
  const [showUpdated, setShowUpdated]       = useState(false);
  const swipeStartY = useRef(0);
  const [showFocusModal, setShowFocusModal] = useState(false);
  const [focusInput, setFocusInput]         = useState("");
  const [ocrCamMode, setOcrCamMode]         = useState(false);
  const [ocrProcessing, setOcrProcessing]   = useState(false);
  const [ocrFound, setOcrFound]             = useState([]);

  // Load persisted OCR capture list on mount
  useEffect(() => {
    AsyncStorage.getItem(OCR_CAPTURE_KEY).then(raw => {
      if (raw) { try { setOcrFound(JSON.parse(raw)); } catch {} }
    });
  }, []);

  // Save ocrFound whenever it changes
  useEffect(() => {
    AsyncStorage.setItem(OCR_CAPTURE_KEY, JSON.stringify(ocrFound)).catch(() => {});
  }, [ocrFound]);
  const [ocrFlash, setOcrFlash]             = useState(false);
  const [lastCapturedUri, setLastCapturedUri] = useState(null); // Option C: show last photo
  const [cameraActive, setCameraActive]       = useState(true);
  const [showOcrManual, setShowOcrManual]     = useState(false);
  const [ocrManualText, setOcrManualText]     = useState("");
  const ocrManualRef = useRef(null);
  const [autoFire, setAutoFire]             = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const inputRef    = useRef(null);
  const focusRef    = useRef(null);
  const ocrCamRef   = useRef(null);
  const autoFireRef = useRef(null);

  const VISION_KEY = "AIzaSyDZ5j5Rj2NtXfwPop2dNafUThQW8ZHhfJA";

  const takeOcrPhoto = async () => {
    if (!ocrCamRef.current || ocrProcessing) return;
    setOcrProcessing(true);
    setCameraActive(false);

    try {
      const photo = await ocrCamRef.current.takePictureAsync({ base64: false, quality: 0.6 });
      let base64Data;
      try {
        const p2=await ImageManipulator.manipulateAsync(photo.uri,[{resize:{width:900}}],{base64:true,compress:0.75,format:ImageManipulator.SaveFormat.JPEG}); base64Data=p2.base64;
      } catch {
        try{const g=await ImageManipulator.manipulateAsync(photo.uri,[{grayscale:true}],{base64:true,compress:0.8,format:ImageManipulator.SaveFormat.PNG});base64Data=g.base64;}
        catch{const r=await ImageManipulator.manipulateAsync(photo.uri,[],{base64:true,compress:0.75,format:ImageManipulator.SaveFormat.JPEG});base64Data=r.base64;}
      }
      const body  = JSON.stringify({ requests: [{ image: { content: base64Data }, features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }] }] });
      const res   = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${VISION_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      const json  = await res.json();
      const text  = json.responses?.[0]?.fullTextAnnotation?.text || "";
      const extractInvoiceIds = (rawText) => {
        const found = new Set();
        const norm = rawText.replace(/[\u2018\u2019\u201C\u201D]/g,"'").replace(/\bI(?=[0-9])/g,"L").replace(/\|(?=[0-9])/g,"L").replace(/l(?=[0-9]{5})/g,"L");
        for (const m of norm.matchAll(/Tax\s+Invoice\s+No\s*:?\s*([A-Z][0-9]{5,8})/gi)) found.add(m[1].toUpperCase());
        for (const m of norm.matchAll(/\bInvoice\s*(?:No\.?\s*)?:?\s*([A-Z][0-9]{5,8})\b/gi)) found.add(m[1].toUpperCase());
        for (const m of norm.matchAll(/\b(L[0-9]{6,7})\b/gi)) found.add(m[1].toUpperCase());
        for (const m of norm.matchAll(/\b(F[0-9]{5,6})\b/gi)) found.add(m[1].toUpperCase());
        for (const m of norm.matchAll(/\b([A-Z][0-9]{5,8})\b/g)) { const id=m[1].toUpperCase(); if(/^(PAGE|DATE|TIME|SLSM|CUST|ABN|FAX|PH)/.test(id))continue; if(/^[PDCTXE][0-9]{1,4}$/.test(id))continue; found.add(id); }
        const corrected=norm.replace(/O(?=[0-9]{5})/g,"0").replace(/(?<=[A-Z])O/g,"0");
        for (const m of corrected.matchAll(/\b([LF][0-9]{5,8})\b/gi)) found.add(m[1].toUpperCase());
        return [...found].filter(id=>/^[A-Z][0-9]{5,8}$/.test(id));
      };
      const unique = extractInvoiceIds(text);
      if (unique.length === 0) {
        Alert.alert("No invoice numbers found", `OCR read the page but found no invoice numbers.\n\nLooking for formats like: L480332, F035944\n\nTips: flatten the paper, better lighting, scan closer to the invoice number.`);
      } else {
        const existingIds = ocrFound.map(x => x.id);
        const brandNew = unique.filter(id => !existingIds.includes(id));
        const alreadyOnBoard = brandNew.filter(id => {
          const inv = invoices.find(i => i.id.toUpperCase() === id);
          return inv && !inv.removedFromBoard && (inv.manuallyAdded || inv.complete || (inv.parts && inv.parts.some(p => p.confirmed > 0)));
        });
        if (alreadyOnBoard.length > 0) {
          Alert.alert(
            "Already on Focus Board",
            `${alreadyOnBoard.join(", ")} ${alreadyOnBoard.length === 1 ? "is" : "are"} already on your Focus Board.`,
            [{ text: "OK" }]
          );
        }
        setOcrFound(prev => {
          const existing = prev.map(x => x.id);
          const newItems = unique.filter(id => !existing.includes(id)).map(id => ({ id, selected: true }));
          return [...prev, ...newItems];
        });
      }
    } catch (e) {
      Alert.alert("OCR Error", e.message || "Failed to process image");
    }
    setOcrProcessing(false);
    setCameraActive(true);
  };

  // Auto-fire: take a photo every 2.5s when autoFire is on
  useEffect(() => {
    if (autoFire && ocrCamMode) {
      autoFireRef.current = setInterval(() => { takeOcrPhoto(); }, 1800);
    } else {
      clearInterval(autoFireRef.current);
    }
    return () => clearInterval(autoFireRef.current);
  }, [autoFire, ocrCamMode]);

  const applyOcrToFocus = () => {
    const ids = ocrFound.filter(x => x.selected).map(x => x.id);
    const combined = [...new Set([
      ...focusInput.split(/[\s,\n]+/).map(s => s.trim().toUpperCase()).filter(Boolean),
      ...ids
    ])];
    setFocusInput(combined.join("\n"));
    setOcrFound([]);
    setOcrCamMode(false);
    // Auto apply and open board
    const matched = combined.filter(id => invoices.some(inv => inv.id.toUpperCase() === id));
    if (matched.length > 0) {
      setFocusList(matched);
      setShowFocusModal(false);
      setTimeout(() => onOpenBoard(), 150);
    } else {
      setShowFocusModal(true);
      setTimeout(() => focusRef.current?.focus(), 200);
    }
  };

  const handleManualSubmit = () => {
    const t = manualText.trim();
    if (!t) return;
    setShowManual(false);
    setManualText("");
    onManualInvoice(t, "precount");
  };

  const handlePullRefresh = async () => {
    setRefreshing(true);
    try { await onSilentSync(); } catch (e) { console.error("silentSync:", e); }
    try { await onDispatchSync(); } catch (e) { console.error("dispatchSync:", e); }
    setRefreshing(false);
    setShowUpdated(true);
    setTimeout(() => setShowUpdated(false), 1500);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />



      {/* Updated pill */}
      {showUpdated && (
        <View style={{ position: "absolute", top: 60, alignSelf: "center", zIndex: 99, backgroundColor: C.green, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Ionicons name="checkmark-circle" size={16} color={C.bg} />
          <Text style={{ color: C.bg, fontSize: 13, fontWeight: "900" }}>Updated</Text>
        </View>
      )}

      {/* Centre */}
      <ScrollView
        contentContainerStyle={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handlePullRefresh} tintColor={C.green} colors={[C.green]} />}
        onTouchStart={(e) => { swipeStartY.current = e.nativeEvent.pageY; }}
        onTouchEnd={(e) => { const dy = swipeStartY.current - e.nativeEvent.pageY; if (dy > 40) setSettingsMenu(true); }}
      >
        <View style={{ alignItems: "center", marginBottom: 20 }}>
          <MaterialCommunityIcons name="truck-delivery-outline" size={72} color={C.green} style={{ marginBottom: 0 }} />
        </View>

        {/* ── Active Boards Strip — tap avatar to request join ── */}
        {activeBoards.filter(b => b.roomId !== currentRoomId).length > 0 && (
          <View style={{ width: "100%", marginBottom: 10 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: C.green }} />
              <Text style={{ color: C.t3, fontSize: 11, fontWeight: "800", letterSpacing: 0.5 }}>ACTIVE BOARDS</Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: "row", gap: 10, paddingBottom: 2 }}>
                {activeBoards.filter(b => b.roomId !== currentRoomId).map(board => (
                  <TouchableOpacity
                    key={board.roomId}
                    activeOpacity={0.75}
                    onPress={() => {
                      if (!userIdentity) { Alert.alert("Set up your identity first"); return; }
                      Alert.alert(
                        `Join "${board.roomName}"?`,
                        `Hosted by ${board.hostInitials} · ${board.memberCount} member${board.memberCount !== 1 ? "s" : ""}`,
                        [
                          { text: "Cancel", style: "cancel" },
                          { text: "Send Request", onPress: () => onRequestJoin(board) },
                        ]
                      );
                    }}
                    style={{ alignItems: "center", gap: 5 }}>
                    <View style={{ width: 52, height: 52, borderRadius: 26,
                      backgroundColor: board.hostColor + "22",
                      borderWidth: 2, borderColor: board.hostColor,
                      alignItems: "center", justifyContent: "center" }}>
                      <Text style={{ color: board.hostColor, fontSize: 16, fontWeight: "900" }}>
                        {board.hostInitials}
                      </Text>
                    </View>
                    <Text style={{ color: C.t2, fontSize: 10, fontWeight: "700", maxWidth: 60, textAlign: "center" }} numberOfLines={1}>
                      {board.roomName}
                    </Text>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                      <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: C.green }} />
                      <Text style={{ color: C.t3, fontSize: 9 }}>{board.memberCount}</Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </View>
        )}

        {/* Receiving divider */}
        <View style={{ width: "100%", flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <View style={{ flex: 1, height: 1, backgroundColor: C.b1 }} />
          <Text style={{ color: C.t3, fontSize: 18, fontWeight: "900", letterSpacing: 1 }}>Receiving</Text>
          <View style={{ flex: 1, height: 1, backgroundColor: C.b1 }} />
        </View>

        {/* AUDOS INVOICE BOARD + SCAN INVOICES icon */}
        <View style={{ width: "100%", flexDirection: "row", gap: 10, marginBottom: 10 }}>
          <TouchableOpacity
            onPress={onOpenBoard}
            activeOpacity={0.85}
            style={{ flex: 1, backgroundColor: C.s2, borderRadius: 20, paddingVertical: 16, paddingHorizontal: 18, justifyContent: "center", flexDirection: "row", gap: 12, borderWidth: 2, borderColor: C.green + "88", alignItems: "center" }}>
            <MaterialCommunityIcons name="view-dashboard-outline" size={28} color={C.green} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: C.green, fontSize: 18, fontWeight: "900", lineHeight: 22 }}>AUDOS INVOICE BOARD</Text>
              <Text style={{ color: C.green + "66", fontSize: 11, fontWeight: "600", marginTop: 3 }}>scan part numbers for Kia {"&"} Hyundai Audos invoices</Text>
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={async () => { if (!cameraPermission?.granted) await requestCameraPermission(); setLastCapturedUri(null); setCameraActive(true); setOcrCamMode(true); }}
            activeOpacity={0.85}
            style={{ width: 72, backgroundColor: C.s2, borderRadius: 20, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: C.b1 }}>
            <Ionicons name="camera-outline" size={28} color={C.t2} />
          </TouchableOpacity>
        </View>

        {/* Dispatch divider */}
        <View style={{ width: "100%", flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10, marginTop: 4 }}>
          <View style={{ flex: 1, height: 1, backgroundColor: C.b1 }} />
          <Text style={{ color: C.t3, fontSize: 18, fontWeight: "900", letterSpacing: 1 }}>Dispatch</Text>
          <View style={{ flex: 1, height: 1, backgroundColor: C.b1 }} />
        </View>

        {/* TRACE TO INVOICE button */}
        <TouchableOpacity
          onPress={() => onFindPartLookup && onFindPartLookup("camera")}
          activeOpacity={0.85}
          style={{ width: "100%", backgroundColor: C.s2, borderRadius: 20, paddingVertical: 16, paddingHorizontal: 22, justifyContent: "center", flexDirection: "row", gap: 14, marginBottom: 10, borderWidth: 2, borderColor: C.blue + "88", alignItems: "center" }}>
          <MaterialCommunityIcons name="magnify-scan" size={28} color={C.blue} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: C.blue, fontSize: 20, fontWeight: "900", lineHeight: 22 }}>TRACE TO INVOICE</Text>
            <Text style={{ color: C.blue + "66", fontSize: 11, fontWeight: "600", marginTop: 3 }}>scans a part number to find its panel shop invoice · or open pre count screen</Text>
          </View>
        </TouchableOpacity>



      </ScrollView>


      {/* 3-dot menu */}
      {/* ── Settings bottom sheet — swipe up anywhere to open ── */}
      <Modal visible={settingsMenu} transparent animationType="slide" onRequestClose={() => setSettingsMenu(false)}>
        <TouchableOpacity style={{ flex: 1, backgroundColor: "#00000088" }} activeOpacity={1} onPress={() => setSettingsMenu(false)} />
        <View style={{ backgroundColor: C.s1, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 48 }}>
          <View style={{ alignSelf: "center", width: 40, height: 4, backgroundColor: C.b1, borderRadius: 2, marginBottom: 16 }} />
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 14 }}>
            <TouchableOpacity onPress={() => setSettingsMenu(false)} activeOpacity={0.7}
              style={{ backgroundColor: C.s2, borderRadius: 10, padding: 8, borderWidth: 1, borderColor: C.b1, marginRight: 12 }}>
              <Ionicons name="arrow-back" size={20} color={C.t2} />
            </TouchableOpacity>
            <Text style={{ color: C.t1, fontSize: 17, fontWeight: "900", flex: 1 }}>Settings</Text>
            <TouchableOpacity onPress={() => setSettingsMenu(false)} activeOpacity={0.7}
              style={{ backgroundColor: C.s2, borderRadius: 10, padding: 8, borderWidth: 1, borderColor: C.b1 }}>
              <Ionicons name="close" size={20} color={C.t2} />
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={() => { setSettingsMenu(false); onClearAll(); }} activeOpacity={0.8}
            style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14, borderRadius: 12, backgroundColor: C.red + "18", marginBottom: 6 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Ionicons name="trash-outline" size={18} color={C.red} />
              <Text style={{ color: C.red, fontSize: 14, fontWeight: "700" }}>Clear all invoices</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={C.red} />
          </TouchableOpacity>
          <View style={{ height: 1, backgroundColor: C.b1, marginVertical: 6 }} />
          {/* Server */}
          <TouchableOpacity onPress={() => { setSettingsMenu(false); onFetchFromServer(); }} activeOpacity={0.8}
            style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14, borderRadius: 12, backgroundColor: C.green + "18", marginBottom: 6 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <MaterialCommunityIcons name="server-network" size={18} color={C.green} />
              <Text style={{ color: C.green, fontSize: 14, fontWeight: "700" }}>Server</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={C.green} />
          </TouchableOpacity>
          {/* Export to email */}
          <TouchableOpacity onPress={() => { setSettingsMenu(false); onExportEmail && onExportEmail(); }} activeOpacity={0.8}
            style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14, borderRadius: 12, backgroundColor: C.green + "18", marginBottom: 6 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <MaterialCommunityIcons name="email-arrow-right-outline" size={18} color={C.green} />
              <Text style={{ color: C.green, fontSize: 14, fontWeight: "700" }}>Export to email</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={C.green} />
          </TouchableOpacity>
          <View style={{ height: 1, backgroundColor: C.b1, marginVertical: 6 }} />
          {/* Hide order numbers */}
          <TouchableOpacity onPress={() => setHideOrderRefs && setHideOrderRefs(v => !v)} activeOpacity={0.8}
            style={{ flexDirection: "row", alignItems: "center", backgroundColor: C.s2, borderRadius: 12, padding: 12, marginBottom: 6, borderWidth: 1, borderColor: hideOrderRefs ? C.orange + "55" : C.b1 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: C.t1, fontSize: 13, fontWeight: "900" }}>Hide order numbers</Text>
              <Text style={{ color: C.t3, fontSize: 11, marginTop: 2 }}>Makes invoice numbers bigger on board</Text>
            </View>
            <View style={{ width: 42, height: 24, borderRadius: 12, backgroundColor: hideOrderRefs ? C.orange + "44" : C.s3, borderWidth: 1, borderColor: hideOrderRefs ? C.orange + "66" : C.b1, justifyContent: "center", paddingHorizontal: 3 }}>
              <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: hideOrderRefs ? C.orange : C.t3, alignSelf: hideOrderRefs ? "flex-end" : "flex-start" }} />
            </View>
          </TouchableOpacity>
          {/* Mute new invoice alerts */}
          <TouchableOpacity onPress={() => setSuppressNewInvAlert && setSuppressNewInvAlert(v => !v)} activeOpacity={0.8}
            style={{ flexDirection: "row", alignItems: "center", backgroundColor: C.s2, borderRadius: 12, padding: 12, marginBottom: 6, borderWidth: 1, borderColor: suppressNewInvAlert ? C.orange + "55" : C.b1 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: C.t1, fontSize: 13, fontWeight: "900" }}>Mute new invoice alerts</Text>
              <Text style={{ color: C.t3, fontSize: 11, marginTop: 2 }}>Hides the popup when scanning a different invoice</Text>
            </View>
            <View style={{ width: 42, height: 24, borderRadius: 12, backgroundColor: suppressNewInvAlert ? C.orange + "44" : C.s3, borderWidth: 1, borderColor: suppressNewInvAlert ? C.orange + "66" : C.b1, justifyContent: "center", paddingHorizontal: 3 }}>
              <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: suppressNewInvAlert ? C.orange : C.t3, alignSelf: suppressNewInvAlert ? "flex-end" : "flex-start" }} />
            </View>
          </TouchableOpacity>
          {/* Dim other cards */}
          <TouchableOpacity onPress={() => setDimOtherCards && setDimOtherCards(v => !v)} activeOpacity={0.8}
            style={{ flexDirection: "row", alignItems: "center", backgroundColor: C.s2, borderRadius: 12, padding: 12, marginBottom: 6, borderWidth: 1, borderColor: dimOtherCards ? C.orange + "55" : C.b1 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: C.t1, fontSize: 13, fontWeight: "900" }}>Dim other cards</Text>
              <Text style={{ color: C.t3, fontSize: 11, marginTop: 2 }}>Highlights the last invoice you were in</Text>
            </View>
            <View style={{ width: 42, height: 24, borderRadius: 12, backgroundColor: dimOtherCards ? C.orange + "44" : C.s3, borderWidth: 1, borderColor: dimOtherCards ? C.orange + "66" : C.b1, justifyContent: "center", paddingHorizontal: 3 }}>
              <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: dimOtherCards ? C.orange : C.t3, alignSelf: dimOtherCards ? "flex-end" : "flex-start" }} />
            </View>
          </TouchableOpacity>
          {/* Hide Find Invoice button */}
          <TouchableOpacity onPress={() => setHideFindBtn && setHideFindBtn(v => !v)} activeOpacity={0.8}
            style={{ flexDirection: "row", alignItems: "center", backgroundColor: C.s2, borderRadius: 12, padding: 12, marginBottom: 6, borderWidth: 1, borderColor: hideFindBtn ? C.orange + "55" : C.b1 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: C.t1, fontSize: 13, fontWeight: "900" }}>Hide "Find Invoice" button</Text>
              <Text style={{ color: C.t3, fontSize: 11, marginTop: 2 }}>Removes the search icon from Focus Board</Text>
            </View>
            <View style={{ width: 42, height: 24, borderRadius: 12, backgroundColor: hideFindBtn ? C.orange + "44" : C.s3, borderWidth: 1, borderColor: hideFindBtn ? C.orange + "66" : C.b1, justifyContent: "center", paddingHorizontal: 3 }}>
              <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: hideFindBtn ? C.orange : C.t3, alignSelf: hideFindBtn ? "flex-end" : "flex-start" }} />
            </View>
          </TouchableOpacity>
          {/* Hide closed invoices */}
          <TouchableOpacity onPress={() => setHideClosedInvoices && setHideClosedInvoices(v => !v)} activeOpacity={0.8}
            style={{ flexDirection: "row", alignItems: "center", backgroundColor: C.s2, borderRadius: 12, padding: 12, marginBottom: 6, borderWidth: 1, borderColor: hideClosedInvoices ? C.orange + "55" : C.b1 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: C.t1, fontSize: 13, fontWeight: "900" }}>Hide closed invoices</Text>
              <Text style={{ color: C.t3, fontSize: 11, marginTop: 2 }}>Only show invoices without a close date</Text>
            </View>
            <View style={{ width: 42, height: 24, borderRadius: 12, backgroundColor: hideClosedInvoices ? C.orange + "44" : C.s3, borderWidth: 1, borderColor: hideClosedInvoices ? C.orange + "66" : C.b1, justifyContent: "center", paddingHorizontal: 3 }}>
              <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: hideClosedInvoices ? C.orange : C.t3, alignSelf: hideClosedInvoices ? "flex-end" : "flex-start" }} />
            </View>
          </TouchableOpacity>
          {/* Hide B/ORDER column in dispatch kanban */}
          <TouchableOpacity onPress={() => hideBackorderColProp !== undefined && setHideBackorderColProp(v => !v)} activeOpacity={0.8}
            style={{ flexDirection: "row", alignItems: "center", backgroundColor: C.s2, borderRadius: 12, padding: 12, marginBottom: 6, borderWidth: 1, borderColor: hideBackorderColProp ? C.orange + "55" : C.b1 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: C.t1, fontSize: 13, fontWeight: "900" }}>Hide B/ORDER column</Text>
              <Text style={{ color: C.t3, fontSize: 11, marginTop: 2 }}>Collapses backorder column in dispatch precount</Text>
            </View>
            <View style={{ width: 42, height: 24, borderRadius: 12, backgroundColor: hideBackorderColProp ? C.orange + "44" : C.s3, borderWidth: 1, borderColor: hideBackorderColProp ? C.orange + "66" : C.b1, justifyContent: "center", paddingHorizontal: 3 }}>
              <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: hideBackorderColProp ? C.orange : C.t3, alignSelf: hideBackorderColProp ? "flex-end" : "flex-start" }} />
            </View>
          </TouchableOpacity>
          <View style={{ height: 1, backgroundColor: C.b1, marginVertical: 6 }} />
          {/* Torch */}
          <TouchableOpacity onPress={() => setTorchEnabled(v => !v)} activeOpacity={0.8}
            style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14, borderRadius: 12, backgroundColor: torchEnabled ? C.amber + "18" : "transparent" }}>
            <Text style={{ color: C.t1, fontSize: 14, fontWeight: "700" }}>{torchEnabled ? "Torch on" : "Torch off"}</Text>
            <View style={{ width: 42, height: 24, borderRadius: 12, backgroundColor: torchEnabled ? C.amber + "44" : C.s3, borderWidth: 1, borderColor: torchEnabled ? C.amber + "66" : C.b1, justifyContent: "center", paddingHorizontal: 3 }}>
              <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: torchEnabled ? C.amber : C.t3, alignSelf: torchEnabled ? "flex-end" : "flex-start" }} />
            </View>
          </TouchableOpacity>
        </View>
      </Modal>

      {/* ── FIND PART LOOKUP result modal ── */}
      {/* ── FIND PART LOOKUP result modal — exact delivery app ── */}
      <Modal visible={!!partLookupResult} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: "#000000AA", justifyContent: "flex-end" }}>
          <View style={{ backgroundColor: C.s1, borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: "80%", paddingBottom: 32, borderTopWidth: 2, borderColor: C.blue + "55" }}>
            <View style={{ alignSelf: "center", width: 44, height: 4, backgroundColor: C.b1, borderRadius: 2, marginTop: 14, marginBottom: 0 }} />
            <View style={{ paddingHorizontal: 24, paddingTop: 20, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: C.b1, marginBottom: 12 }}>
              <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" }}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 }}>
                    <MaterialCommunityIcons name="magnify-scan" size={18} color={C.blue} />
                    <Text style={{ color: C.blue, fontSize: 11, fontWeight: "900", letterSpacing: 2 }}>PART LOOKUP</Text>
                  </View>
                  <Text style={{ color: C.t1, fontSize: 28, fontWeight: "900", letterSpacing: 0.5 }}>{partLookupResult?.partNumber}</Text>
                  {partLookupResult?.matches?.length > 0
                    ? <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 }}>
                        <View style={{ backgroundColor: C.green + "22", borderRadius: 20, paddingHorizontal: 10, paddingVertical: 3, borderWidth: 1, borderColor: C.green + "55" }}>
                          <Text style={{ color: C.green, fontSize: 12, fontWeight: "800" }}>FOUND ON {partLookupResult.matches.length} INVOICE{partLookupResult.matches.length !== 1 ? "S" : ""}</Text>
                        </View>
                      </View>
                    : <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 }}>
                        <View style={{ backgroundColor: C.red + "22", borderRadius: 20, paddingHorizontal: 10, paddingVertical: 3, borderWidth: 1, borderColor: C.red + "55" }}>
                          <Text style={{ color: C.red, fontSize: 12, fontWeight: "800" }}>NOT ON ANY INVOICE TODAY</Text>
                        </View>
                      </View>
                  }
                </View>
                <TouchableOpacity onPress={() => setPartLookupResult(null)}
                  style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: C.s3, alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: C.b1, marginLeft: 12 }}
                  activeOpacity={0.7}>
                  <Text style={{ color: C.t1, fontSize: 22, fontWeight: "900", lineHeight: 26 }}>✕</Text>
                </TouchableOpacity>
              </View>
            </View>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 14, gap: 10 }}>
              {(partLookupResult?.matches || []).map((match, i) => {
                const statusColor = match.status === "DELIVERED" ? C.green : match.status === "ON VAN" ? C.blue : match.status === "LOADING" ? C.amber : match.status === "PRECOUNTED" ? C.green : match.status === "CLOSED" ? C.red : C.green;
                const partOnInv = match.part;
                const scannedQty = Math.max(partOnInv.loaded || 0, partOnInv.delivered || 0, partOnInv.precounted || 0);
                return (
                  <TouchableOpacity key={i} activeOpacity={0.85}
                    onLongPress={() => { Vibration.vibrate(40); setPartLookupResult(null); setTimeout(() => { onOpenDispatchPrecount && onOpenDispatchPrecount(match.invId); }, 150); }}
                    delayLongPress={500}
                    style={{ backgroundColor: C.bg, borderRadius: 18, borderWidth: 2, borderColor: statusColor + "66", padding: 18, elevation: 4 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                      <Text style={{ color: C.t1, fontSize: 22, fontWeight: "900" }}>#{match.invId}</Text>
                      <View style={{ backgroundColor: statusColor, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 5 }}>
                        <Text style={{ color: "#000", fontSize: 11, fontWeight: "900", letterSpacing: 0.5 }}>{match.status}</Text>
                      </View>
                    </View>
                    <Text style={{ color: C.t1, fontSize: 15, fontWeight: "800", marginBottom: 3 }}>{match.customer}</Text>
                    {match.reqDate ? <Text style={{ color: C.t3, fontSize: 12, marginBottom: match.part?.comment ? 4 : 10 }}>Req: {match.reqDate}</Text> : <View style={{ marginBottom: match.part?.comment ? 4 : 10 }} />}
                    {match.part?.comment ? (
                      <View style={{ backgroundColor: C.blue + "18", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: C.blue + "44", marginBottom: 10, flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <Ionicons name="chatbubble-outline" size={13} color={C.blue} />
                        <Text style={{ color: C.blue, fontSize: 13, fontWeight: "700", flex: 1 }}>{match.part.comment}</Text>
                      </View>
                    ) : null}
                    <View style={{ flexDirection: "row", gap: 10 }}>
                      <View style={{ flex: 1, backgroundColor: C.s2, borderRadius: 12, padding: 12, alignItems: "center" }}>
                        <Text style={{ color: C.t3, fontSize: 10, fontWeight: "700", letterSpacing: 1, marginBottom: 2 }}>QTY NEEDED</Text>
                        <Text style={{ color: C.t1, fontSize: 24, fontWeight: "900" }}>{partOnInv.expected ?? "—"}</Text>
                      </View>
                      {scannedQty > 0 && (
                        <View style={{ flex: 1, backgroundColor: statusColor + "22", borderRadius: 12, padding: 12, alignItems: "center", borderWidth: 1, borderColor: statusColor + "55" }}>
                          <Text style={{ color: C.t3, fontSize: 10, fontWeight: "700", letterSpacing: 1, marginBottom: 2 }}>SCANNED</Text>
                          <Text style={{ color: statusColor, fontSize: 24, fontWeight: "900" }}>{scannedQty}</Text>
                        </View>
                      )}
                    </View>
                    <Text style={{ color: C.t3, fontSize: 10, fontWeight: "600", marginTop: 10, textAlign: "center", letterSpacing: 0.5 }}>Hold to open PreCount →</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity
              onPress={() => { setPartLookupResult(null); setTimeout(() => onFindPartLookup && onFindPartLookup("camera"), 100); }}
              style={{ marginHorizontal: 16, marginTop: 16, backgroundColor: C.blue, borderRadius: 16, padding: 20, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 10 }}>
              <MaterialCommunityIcons name="barcode-scan" size={22} color="#fff" />
              <Text style={{ color: "#fff", fontSize: 17, fontWeight: "900", letterSpacing: 0.5 }}>Rescan</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── FIND PART result modal ── */}
      <Modal visible={!!kiaPartResult} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: "#000000AA", justifyContent: "flex-end" }}>
          <View style={{ backgroundColor: C.s1, borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: "85%", paddingBottom: 20, borderTopWidth: 2, borderColor: C.blue + "55" }}>
            <View style={{ alignSelf: "center", width: 44, height: 4, backgroundColor: C.b1, borderRadius: 2, marginTop: 14 }} />

            {/* Header — part number + X + Add to Focus Board */}
            <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: C.b1 }}>
              <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10 }}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <MaterialCommunityIcons name="magnify-scan" size={16} color={C.blue} />
                    <Text style={{ color: C.blue, fontSize: 10, fontWeight: "900", letterSpacing: 2 }}>PART LOOKUP</Text>
                  </View>
                  <Text style={{ color: C.t1, fontSize: 26, fontWeight: "900" }}>{kiaPartResult?.partNumber}</Text>
                  <View style={{ marginTop: 5 }}>
                    {kiaPartResult?.matches?.length > 0
                      ? <View style={{ backgroundColor: C.green + "22", borderRadius: 20, paddingHorizontal: 10, paddingVertical: 3, borderWidth: 1, borderColor: C.green + "55", alignSelf: "flex-start" }}>
                          <Text style={{ color: C.green, fontSize: 11, fontWeight: "800" }}>FOUND ON {kiaPartResult.matches.length} INVOICE{kiaPartResult.matches.length !== 1 ? "S" : ""}</Text>
                        </View>
                      : <View style={{ backgroundColor: C.red + "22", borderRadius: 20, paddingHorizontal: 10, paddingVertical: 3, borderWidth: 1, borderColor: C.red + "55", alignSelf: "flex-start" }}>
                          <Text style={{ color: C.red, fontSize: 11, fontWeight: "800" }}>NOT FOUND</Text>
                        </View>
                    }
                  </View>
                </View>
                <TouchableOpacity onPress={() => setKiaPartResult(null)}
                  style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.s3, alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: C.b1, marginLeft: 10 }}
                  activeOpacity={0.7}>
                  <Ionicons name="close" size={22} color={C.t2} />
                </TouchableOpacity>
              </View>

            </View>

            {/* Invoice list */}
            <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 10, gap: 8 }}>
              {(kiaPartResult?.matches || []).map((match, i) => {
                const statusColor = match.complete ? C.green : match.hasShort ? C.amber : C.red;
                const statusLabel = match.complete ? "COMPLETE" : match.hasShort ? "SHORT" : "PENDING";
                return (
                  <TouchableOpacity key={i} activeOpacity={0.85}
                    onPress={() => { setKiaPartResult(null); onOpenInvoice(match.invId); }}
                    style={{ backgroundColor: C.s2, borderRadius: 12, padding: 14, borderLeftWidth: 4, borderLeftColor: statusColor, borderTopWidth: 0, borderRightWidth: 0, borderBottomWidth: 0 }}>
                    {/* Invoice ID + big order ref */}
                    <Text style={{ color: C.t1, fontSize: 18, fontWeight: "900", marginBottom: 4 }}>{match.invId}</Text>
                    <Text style={{ color: C.t1, fontSize: 22, fontWeight: "900", marginBottom: 10 }}>{match.orderRef || "—"}</Text>
                    {/* Status + Add side by side */}
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                      <View style={{ flex: 1, backgroundColor: statusColor + "22", borderRadius: 10, paddingVertical: 12, alignItems: "center", borderWidth: 1, borderColor: statusColor + "55" }}>
                        <Text style={{ color: statusColor, fontSize: 13, fontWeight: "900" }}>{statusLabel}</Text>
                      </View>
                      {(() => {
                        const onBoard = invoices.some(i => i.id === match.invId && !i.removedFromBoard && (i.manuallyAdded || i.complete || (i.parts && i.parts.some(p => p.confirmed > 0))));
                        return onBoard
                          ? <View style={{ flex: 1, backgroundColor: C.blue + "22", borderRadius: 10, paddingVertical: 12, alignItems: "center", borderWidth: 1, borderColor: C.blue + "55" }}>
                              <Text style={{ color: C.blue, fontSize: 12, fontWeight: "900" }}>ON FOCUS BOARD</Text>
                            </View>
                          : <TouchableOpacity
                              onPress={(e) => { e.stopPropagation(); onAddToPending([match.invId]); }}
                              activeOpacity={0.8}
                              style={{ flex: 1, backgroundColor: C.green, borderRadius: 10, paddingVertical: 12, alignItems: "center" }}>
                              <Text style={{ color: C.bg, fontSize: 13, fontWeight: "900" }}>+ ADD</Text>
                            </TouchableOpacity>;
                      })()}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            {/* Rescan */}
            <TouchableOpacity onPress={() => { setKiaPartResult(null); setTimeout(() => onScanFindPart("camera"), 100); }}
              style={{ marginHorizontal: 16, marginTop: 12, backgroundColor: C.s2, borderRadius: 16, paddingVertical: 16, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 10, borderWidth: 1, borderColor: C.b1 }}>
              <MaterialCommunityIcons name="barcode-scan" size={20} color={C.t2} />
              <Text style={{ color: C.t2, fontSize: 16, fontWeight: "900" }}>Rescan</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Manual entry modal */}
      <Modal visible={showManual} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: "#00000088", justifyContent: "flex-end" }}>
          <View style={{ backgroundColor: C.s1, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 28 }}>
            <Text style={{ color: C.t1, fontSize: 20, fontWeight: "800", marginBottom: 16 }}>Open Invoice</Text>
            <TextInput ref={inputRef} value={manualText} onChangeText={setManualText} placeholder="e.g. L470549"
              placeholderTextColor={C.t3} autoCapitalize="characters" onSubmitEditing={handleManualSubmit}
              style={{ backgroundColor: C.s2, borderRadius: 14, padding: 18, color: C.t1, fontSize: 20, fontWeight: "800", borderWidth: 1, borderColor: C.b1, marginBottom: 16 }} />
            <TouchableOpacity onPress={handleManualSubmit} activeOpacity={0.85}
              style={{ backgroundColor: C.orange, borderRadius: 16, padding: 20, alignItems: "center", marginBottom: 10 }}>
              <Text style={{ color: C.bg, fontSize: 18, fontWeight: "900" }}>OPEN INVOICE</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowManual(false)} style={{ paddingVertical: 14, paddingHorizontal: 40, alignItems: "center", alignSelf: "center", minWidth: 120 }}>
              <Text style={{ color: C.t3, fontSize: 16, letterSpacing: 0.5 }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── OCR CAMERA MODAL — Layout A ── */}
      <Modal visible={ocrCamMode} transparent={false} animationType="slide" statusBarTranslucent>
        <View style={{ flex: 1, backgroundColor: C.bg }}>
          <StatusBar barStyle="light-content" backgroundColor={C.s2} translucent={false} />

          {/* Header — always on top, never hidden */}
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 44, paddingBottom: 12, gap: 10, backgroundColor: C.s2, borderBottomWidth: 1, borderBottomColor: C.b1, zIndex: 10 }}>
            <TouchableOpacity onPress={() => { setOcrCamMode(false); setAutoFire(false); setCameraActive(true); }} activeOpacity={0.7}
              style={{ backgroundColor: C.s3, borderRadius: 10, padding: 8, borderWidth: 1, borderColor: C.b1 }}>
              <Ionicons name="arrow-back" size={20} color={C.t2} />
            </TouchableOpacity>
            <Text style={{ color: C.t1, fontSize: 24, fontWeight: "900", flex: 1 }}>Scan Invoices</Text>
            {ocrProcessing
              ? <View style={{ backgroundColor: C.amber + "22", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: C.amber + "55" }}>
                  <Text style={{ color: C.amber, fontSize: 17, fontWeight: "900" }}>Processing...</Text>
                </View>
              : <View style={{ backgroundColor: C.green + "22", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: C.green + "55" }}>
                  <Text style={{ color: C.green, fontSize: 17, fontWeight: "900" }}>{ocrFound.length} found</Text>
                </View>
            }
            <TouchableOpacity onPress={() => setOcrFlash(v => !v)} activeOpacity={0.7}
              style={{ backgroundColor: ocrFlash ? C.amber + "22" : C.s3, borderRadius: 10, padding: 8, borderWidth: 1, borderColor: ocrFlash ? C.amber + "55" : C.b1 }}>
              <Ionicons name={ocrFlash ? "flash" : "flash-outline"} size={20} color={ocrFlash ? C.amber : C.t3} />
            </TouchableOpacity>
          </View>

          {/* Option C: camera always mounted, still overlaid after capture */}
          <View style={{ height: 260, backgroundColor: "#000", overflow: "hidden" }}>
            <CameraView ref={ocrCamRef} style={{ flex: 1 }} facing="back" enableTorch={ocrFlash} />
            {/* Manual entry icon — top right of camera */}
            <TouchableOpacity
              onPress={() => { setOcrManualText(""); setShowOcrManual(true); setTimeout(() => ocrManualRef.current?.focus(), 150); }}
              activeOpacity={0.8}
              style={{ position: "absolute", top: 10, right: 10, backgroundColor: "#00000088", borderRadius: 10, padding: 10, borderWidth: 1, borderColor: "#ffffff22" }}>
              <MaterialCommunityIcons name="keyboard-outline" size={22} color="#fff" />
            </TouchableOpacity>
            {(!cameraActive || ocrProcessing) && (
              <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#000", alignItems: "center", justifyContent: "center" }}>
                {ocrProcessing && (
                  <>
                    <MaterialCommunityIcons name="loading" size={40} color={C.amber} style={{ marginBottom: 10 }} />
                    <Text style={{ color: C.amber, fontSize: 16, fontWeight: "900" }}>Reading photo...</Text>
                  </>
                )}
              </View>
            )}
          </View>

          {/* Captured list */}
          <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: 14 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <Text style={{ color: C.t3, fontSize: 14, fontWeight: "900", letterSpacing: 1 }}>CAPTURED SO FAR</Text>
              <TouchableOpacity
                onPress={() => {
                  if (ocrFound.length === 0) return;
                  Alert.alert("Clear Captured?", "This will reset your captured invoice list.", [
                    { text: "Cancel", style: "cancel" },
                    { text: "Clear", style: "destructive", onPress: () => {
                      setOcrFound([]);
                      setLastCapturedUri(null);
                    }},
                  ]);
                }}
                disabled={ocrFound.length === 0}
                activeOpacity={0.7}
                style={{ flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: ocrFound.length > 0 ? C.red + "22" : C.s3,
                  borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5, borderWidth: 1,
                  borderColor: ocrFound.length > 0 ? C.red + "55" : C.b1, opacity: ocrFound.length === 0 ? 0.4 : 1 }}>
                <MaterialCommunityIcons name="refresh" size={13} color={ocrFound.length > 0 ? C.red : C.t3} />
                <Text style={{ color: ocrFound.length > 0 ? C.red : C.t3, fontSize: 11, fontWeight: "800" }}>CLEAR</Text>
              </TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              {ocrFound.length === 0 && (
                <Text style={{ color: C.t3, fontSize: 20, textAlign: "center", marginTop: 24 }}>tap capture for next invoice</Text>
              )}
              {ocrFound.map((item, i) => {
                const inCsv = invoices.some(inv => inv.id.toUpperCase() === item.id);
                const invData = invoices.find(inv => inv.id.toUpperCase() === item.id);
                const onBoard = invData && !invData.removedFromBoard && (invData.manuallyAdded || invData.complete || (invData.parts && invData.parts.some(p => p.confirmed > 0)));
                const borderColor = !inCsv ? C.amber : onBoard ? C.blue : C.green;
                return (
                  <View key={item.id} style={{ backgroundColor: C.s2, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 8, flexDirection: "row", alignItems: "center", borderLeftWidth: 3, borderLeftColor: borderColor, borderTopWidth: 0, borderRightWidth: 0, borderBottomWidth: 0 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: C.t1, fontSize: 23, fontWeight: "900" }}>{item.id}</Text>
                      {onBoard && <Text style={{ color: C.blue, fontSize: 12, fontWeight: "700", marginTop: 2 }}>Already on Focus Board</Text>}
                    </View>
                    {!inCsv && <Text style={{ color: C.amber, fontSize: 15, fontWeight: "900", marginRight: 8 }}>NOT IN CSV</Text>}
                    <TouchableOpacity onPress={() => setOcrFound(prev => prev.filter((_, xi) => xi !== i))} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                      <Ionicons name="close" size={18} color={C.t3} />
                    </TouchableOpacity>
                  </View>
                );
              })}
            </ScrollView>
          </View>

          {/* Bottom — ADD TO PENDING (smaller, top) + CAPTURE (bigger, bottom) */}
          <View style={{ paddingHorizontal: 16, paddingBottom: 64, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.b1, backgroundColor: C.bg, gap: 10 }}>
            {(() => {
              const matchCount = ocrFound.filter(x => invoices.some(inv => inv.id.toUpperCase() === x.id)).length;
              const hasMatches = matchCount > 0;
              return (
                <>
                  <TouchableOpacity
                    onPress={() => {
                      if (!hasMatches) return;
                      const ids = ocrFound.filter(x => invoices.some(inv => inv.id.toUpperCase() === x.id)).map(x => x.id);
                      onAddToPending(ids);
                      setOcrCamMode(false);
                      setOcrFound([]);
                      setLastCapturedUri(null);
                      setCameraActive(true);
                      setTimeout(() => onOpenBoard(), 150);
                    }}
                    activeOpacity={0.85}
                    disabled={!hasMatches}
                    style={{ backgroundColor: hasMatches ? C.s2 : C.s3, borderRadius: 14, paddingVertical: 14, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8, borderWidth: 1.5, borderColor: hasMatches ? C.green + "66" : C.b1 }}>
                    <Text style={{ color: hasMatches ? C.green : C.t3, fontSize: 23, fontWeight: "900" }}>
                      ADD {matchCount} TO PENDING
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={async () => { setCameraActive(true); await new Promise(r => setTimeout(r, 100)); takeOcrPhoto(); }}
                    activeOpacity={0.85}
                    disabled={ocrProcessing}
                    style={{ backgroundColor: ocrProcessing ? C.s3 : C.green, borderRadius: 16, paddingVertical: 26, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 10 }}>
                    <Ionicons name="camera" size={28} color={ocrProcessing ? C.t3 : C.bg} />
                    <Text style={{ color: ocrProcessing ? C.t3 : C.bg, fontSize: 22, fontWeight: "900" }}>CAPTURE</Text>
                  </TouchableOpacity>
                </>
              );
            })()}
          </View>

          {/* Manual invoice entry modal */}
          <Modal visible={showOcrManual} transparent animationType="slide" onRequestClose={() => setShowOcrManual(false)}>
            <TouchableOpacity style={{ flex: 1, backgroundColor: "#00000088" }} activeOpacity={1} onPress={() => setShowOcrManual(false)} />
            <View style={{ backgroundColor: C.s1, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 48 }}>
              <View style={{ alignSelf: "center", width: 40, height: 4, backgroundColor: C.b1, borderRadius: 2, marginBottom: 20 }} />
              <Text style={{ color: C.t1, fontSize: 20, fontWeight: "900", marginBottom: 16 }}>Add Invoice Manually</Text>
              <TextInput
                ref={ocrManualRef}
                value={ocrManualText}
                onChangeText={t => setOcrManualText(t.toUpperCase())}
                placeholder="e.g. L475566"
                placeholderTextColor={C.t3}
                autoCapitalize="characters"
                style={{ backgroundColor: C.s2, borderRadius: 14, padding: 18, color: C.t1, fontSize: 20, fontWeight: "800", borderWidth: 1, borderColor: C.b1, marginBottom: 16 }}
                onSubmitEditing={() => {
                  const id = ocrManualText.trim().toUpperCase();
                  if (id.length >= 3) {
                    setOcrFound(prev => {
                      if (prev.some(x => x.id === id)) return prev;
                      return [...prev, { id, selected: true }];
                    });
                  }
                  setShowOcrManual(false);
                  setOcrManualText("");
                }}
              />
              <TouchableOpacity
                onPress={() => {
                  const id = ocrManualText.trim().toUpperCase();
                  if (id.length >= 3) {
                    setOcrFound(prev => {
                      if (prev.some(x => x.id === id)) return prev;
                      return [...prev, { id, selected: true }];
                    });
                  }
                  setShowOcrManual(false);
                  setOcrManualText("");
                }}
                activeOpacity={0.85}
                style={{ backgroundColor: C.green, borderRadius: 14, paddingVertical: 18, alignItems: "center" }}>
                <Text style={{ color: C.bg, fontSize: 18, fontWeight: "900" }}>ADD TO LIST</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setShowOcrManual(false)} style={{ paddingVertical: 14, alignItems: "center" }}>
                <Text style={{ color: C.t3, fontSize: 16 }}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </Modal>

        </View>
      </Modal>

      {/* ── FOCUS LIST MODAL ── */}
      <Modal visible={showFocusModal} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: "#00000088", justifyContent: "flex-end" }}>
          <View style={{ backgroundColor: C.s1, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 48 }}>
            <View style={{ alignSelf: "center", width: 40, height: 4, backgroundColor: C.b1, borderRadius: 2, marginBottom: 20 }} />

            {/* Header row */}
            <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 6 }}>
              <MaterialCommunityIcons name="format-list-checks" size={20} color={C.green} style={{ marginRight: 10 }} />
              <Text style={{ color: C.t1, fontSize: 18, fontWeight: "900", flex: 1 }}>Focus List</Text>
              <TouchableOpacity
                onPress={async () => { if (!cameraPermission?.granted) await requestCameraPermission(); setLastCapturedUri(null); setCameraActive(true); setOcrCamMode(true); }}
                activeOpacity={0.8}
                style={{ backgroundColor: C.blue + "22", borderRadius: 12, padding: 10, borderWidth: 1.5, borderColor: C.blue + "66", flexDirection: "row", alignItems: "center", gap: 6, marginRight: 8 }}>
                <Ionicons name="camera-outline" size={20} color={C.blue} />
                <Text style={{ color: C.blue, fontSize: 13, fontWeight: "900" }}>OCR</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={async () => { if (!cameraPermission?.granted) await requestCameraPermission(); setLastCapturedUri(null); setCameraActive(true); setOcrCamMode(true); }}
                activeOpacity={0.8}
                style={{ backgroundColor: C.green + "22", borderRadius: 12, padding: 10, borderWidth: 1.5, borderColor: C.green + "66", flexDirection: "row", alignItems: "center", gap: 6 }}>
                <MaterialCommunityIcons name="barcode-scan" size={20} color={C.green} />
                <Text style={{ color: C.green, fontSize: 13, fontWeight: "900" }}>SCAN</Text>
              </TouchableOpacity>
            </View>

            <Text style={{ color: C.t3, fontSize: 13, marginBottom: 16 }}>
              Type, paste, or scan invoice numbers (L47...) to focus the list.
            </Text>

            <TextInput
              ref={focusRef}
              value={focusInput}
              onChangeText={setFocusInput}
              placeholder={"e.g. L470439, L470529\nL470549"}
              placeholderTextColor={C.t3}
              autoCapitalize="characters"
              multiline
              style={{ backgroundColor: C.s2, borderRadius: 14, padding: 16, color: C.t1, fontSize: 15, borderWidth: 1.5, borderColor: C.green + "55", minHeight: 80, textAlignVertical: "top", marginBottom: 16 }}
            />

            <TouchableOpacity
              onPress={() => {
                const ids = [...new Set(focusInput.split(/[\s,\n]+/).map(s => s.trim().toUpperCase()).filter(Boolean))];
                setFocusList(ids);
                setShowFocusModal(false);
                if (ids.length > 0) setTimeout(() => onOpenBoard(), 150);
              }}
              activeOpacity={0.85}
              style={{ backgroundColor: C.green, borderRadius: 14, padding: 18, alignItems: "center", marginBottom: 10 }}>
              <Text style={{ color: C.bg, fontSize: 17, fontWeight: "900" }}>
                APPLY FOCUS LIST{focusInput.trim().length > 0 ? ` (${[...new Set(focusInput.split(/[\s,\n]+/).map(s=>s.trim().toUpperCase()).filter(Boolean))].length})` : ""}
              </Text>
            </TouchableOpacity>

            {focusList.length > 0 && (
              <TouchableOpacity onPress={() => { setFocusList([]); setShowFocusModal(false); }} style={{ padding: 12, alignItems: "center" }}>
                <Text style={{ color: C.amber, fontSize: 14, fontWeight: "700" }}>Clear Focus & Show All</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => setShowFocusModal(false)} style={{ padding: 10, alignItems: "center" }}>
              <Text style={{ color: C.t3, fontSize: 15, letterSpacing: 0.5 }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}


// ─── KIA INVOICE LIST SCREEN ──────────────────────────────────────────────────
// ─── FOCUS BATCH SCANNER ─────────────────────────────────────────────────────
function FocusBatchScanner({ visible, torchEnabled, scannedIds, onScan, onDone, onClose }) {
  const [permission, requestPermission] = useCameraPermissions();
  const lastScanRef = useRef("");
  const lastTimeRef = useRef(0);
  const COOLDOWN    = 1200;

  if (!visible) return null;

  if (!permission?.granted) {
    return (
      <Modal visible animationType="slide">
        <SafeAreaView style={{ flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center", padding: 32 }}>
          <Ionicons name="camera-outline" size={64} color={C.amber} style={{ marginBottom: 20 }} />
          <Text style={{ color: C.t1, fontSize: 22, fontWeight: "800", marginBottom: 10 }}>Camera needed</Text>
          <TouchableOpacity onPress={requestPermission} style={{ backgroundColor: C.green, borderRadius: 16, padding: 18, width: "100%", alignItems: "center", marginBottom: 12 }}>
            <Text style={{ color: C.bg, fontWeight: "900", fontSize: 18 }}>Allow Camera</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onClose} style={{ padding: 16 }}>
            <Text style={{ color: C.t3, fontSize: 16, letterSpacing: 0.5 }}>Cancel</Text>
          </TouchableOpacity>
        </SafeAreaView>
      </Modal>
    );
  }

  const handleScan = ({ data }) => {
    if (!data) return;
    const now = Date.now();
    const raw = String(data).trim().toUpperCase();
    if (raw === lastScanRef.current && now - lastTimeRef.current < COOLDOWN) return;
    lastScanRef.current = raw;
    lastTimeRef.current = now;
    // Accept anything that looks like an invoice starting with L + digits
    const match = raw.match(/L\d{4,}/);
    if (match) {
      Vibration.vibrate(40);
      onScan(match[0]);
    }
  };

  return (
    <Modal visible animationType="slide">
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        <StatusBar barStyle="light-content" backgroundColor="#000" />
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          enableTorch={!!torchEnabled}
          barcodeScannerSettings={{ barcodeTypes: ["code128", "code39", "ean13", "ean8", "qr", "pdf417"] }}
          onBarcodeScanned={handleScan}
        />

        {/* Top strip */}
        <View style={{ position: "absolute", top: 0, left: 0, right: 0, backgroundColor: C.green, paddingTop: 52, paddingBottom: 18, paddingHorizontal: 24, flexDirection: "row", alignItems: "center", gap: 14 }}>
          <Text style={{ fontSize: 26 }}>📋</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ color: "#00000088", fontSize: 10, fontWeight: "900", letterSpacing: 3 }}>FOCUS LIST</Text>
            <Text style={{ color: "#000", fontSize: 18, fontWeight: "900" }}>Scan Invoice Barcodes</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={{ backgroundColor: "#00000033", borderRadius: 10, padding: 8 }}>
            <Ionicons name="close" size={22} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Scan frame guide */}
        <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }} pointerEvents="none">
          <View style={{ width: 280, height: 100, borderRadius: 14, borderWidth: 2.5, borderColor: C.green + "CC", backgroundColor: "transparent" }} />
          <Text style={{ color: "#ffffffCC", fontSize: 13, marginTop: 14, fontWeight: "700" }}>Point at invoice barcode</Text>
        </View>

        {/* Bottom panel */}
        <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, backgroundColor: "#000000EE", paddingBottom: 64, paddingTop: 16, paddingHorizontal: 20 }}>
          {/* Scanned chips */}
          {scannedIds.length > 0 ? (
            <>
              <Text style={{ color: C.green, fontWeight: "900", fontSize: 12, letterSpacing: 1, marginBottom: 10 }}>
                ✓ {scannedIds.length} SCANNED — KEEP GOING OR TAP DONE
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  {scannedIds.map(id => (
                    <View key={id} style={{ backgroundColor: C.green + "22", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1.5, borderColor: C.green + "66" }}>
                      <Text style={{ color: C.green, fontWeight: "900", fontSize: 13 }}>{id}</Text>
                    </View>
                  ))}
                </View>
              </ScrollView>
              <TouchableOpacity onPress={onDone} activeOpacity={0.85}
                style={{ backgroundColor: C.green, borderRadius: 16, paddingVertical: 18, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 10 }}>
                <MaterialCommunityIcons name="check-bold" size={22} color="#000" />
                <Text style={{ color: "#000", fontSize: 18, fontWeight: "900" }}>Done — Add {scannedIds.length} to List</Text>
              </TouchableOpacity>
            </>
          ) : (
            <Text style={{ color: "#ffffff88", fontSize: 14, textAlign: "center", paddingVertical: 12 }}>
              Scan the first invoice barcode to begin...
            </Text>
          )}
        </View>
      </View>
    </Modal>
  );
}

function KiaDetailScreen({ invoice, onBack, setKiaInvoices, torchEnabled, initialPartNumber, onClearInitialPart, userIdentity, wsRef, currentRoomId }) {
  const insets = useSafeAreaInsets();
  const [showScanner, setShowScanner]     = useState(false);
  const [feedback, setFeedback]           = useState(null);
  const [scanPopup, setScanPopup]         = useState(null);
  const [qtyModal, setQtyModal]           = useState(null);
  const [qtyInput, setQtyInput]           = useState("");
  const [overrideModal, setOverrideModal] = useState(null);
  const [filter, setFilter]               = useState("all");
  const [lastScanned, setLastScannedState] = useState(null);

  const setLastScanned = (val) => {
    setLastScannedState(val);
    const key = `@kia_lastscanned_detail_${invoice.id}`;
    if (val) AsyncStorage.setItem(key, JSON.stringify(val)).catch(() => {});
    else AsyncStorage.removeItem(key).catch(() => {});
  };

  useEffect(() => {
    AsyncStorage.getItem(`@kia_lastscanned_detail_${invoice.id}`).then(raw => {
      if (raw) { try { setLastScannedState(JSON.parse(raw)); } catch {} }
    });
  }, []);
  const scrollRef = useRef(null);
  const doneScrollRef = useRef(null);
  const doneCardYRefs = useRef({});
  const allPartYRefs = useRef({}); // { "partNumber+lineNo": y } for ALL columns
  const allColScrollRefs = useRef({}); // { colKey: scrollRef } for ALL columns
  const [flashPartKey, setFlashPartKey] = useState(null);
  const [confirmPopup, setConfirmPopup] = useState(null); // { idx, partNumber, qty }

  useEffect(() => {
    if (initialPartNumber && invoice?.parts) {
      const idx = invoice.parts.findIndex(p => p.partNumber.toUpperCase() === initialPartNumber.toUpperCase());
      if (idx !== -1) {
        const p = invoice.parts[idx];
        const alreadyDone = p.short || p.confirmed >= p.qty;
        if (alreadyDone) {
          // Already confirmed — scroll to it then flash
          const cardKey = p.partNumber + p.lineNo;
          setTimeout(() => {
            setFilter("all");
            setTimeout(() => {
              const ref = allPartYRefs.current[cardKey];
              if (ref) allColScrollRefs.current[ref.col]?.scrollTo({ y: ref.y, animated: true });
              setFlashPartKey(cardKey);
              setTimeout(() => setFlashPartKey(null), 1800);
            }, 150);
          }, 300);
        } else {
          // Not yet confirmed — show confirm popup
          setTimeout(() => setConfirmPopup({ idx, partNumber: p.partNumber, qty: p.qty, confirmed: p.confirmed }), 400);
        }
      }
      onClearInitialPart && onClearInitialPart();
    }
  }, []);

  const allParts       = invoice.parts;
  const confirmedCount = allParts.filter(p => p.short || p.confirmed > 0).length;
  const allDone        = confirmedCount === allParts.length && allParts.length > 0;
  const pendingCount   = allParts.length - confirmedCount;

  const filteredParts = allParts.filter(p => {
    const done = p.short || p.confirmed > 0;
    if (filter === "done")    return done;
    if (filter === "pending") return !done;
    if (filter === "short")   return p.short;
    return true;
  });

  const shortParts = allParts.filter(p => p.short);

  const showFeedback = (msg, color) => {
    setFeedback({ msg, color });
    setTimeout(() => setFeedback(null), 1800);
  };

  const showScanPopup = (icon, label, color, sub) => {
    setScanPopup({ icon, label, color, sub });
    setTimeout(() => setScanPopup(null), 1200);
  };

  const wsBroadcastPart = (part, idx) => {
    if (!wsRef?.current || wsRef.current.readyState !== 1 || !currentRoomId || !userIdentity) return;
    wsRef.current.send(JSON.stringify({
      type: "part_update",
      invId: invoice.id,
      partKey: part.partNumber + "_" + (part.lineNo || "0"),
      confirmed: part.confirmed,
      short: part.short || false,
      shortQty: part.shortQty || 0,
      initials: userIdentity.initials,
      color: userIdentity.color,
      userId: userIdentity.id,
      timestamp: Date.now(),
    }));
  };

  const confirmPart = (idx, qty) => {
    const clamped = Math.min(Math.max(1, qty), invoice.parts[idx].qty);
    const ts = Date.now();
    Vibration.vibrate(60);
    // Conflict check — already confirmed by someone else?
    const existing = invoice.parts[idx];
    if (existing.confirmedBy && existing.confirmedBy !== userIdentity?.initials && existing.confirmed >= existing.qty) {
      Alert.alert("Already confirmed", `Already confirmed by ${existing.confirmedBy} at ${fmtTime(existing.confirmedAt)}`);
      return;
    }
    const updatedPart = { ...existing, confirmed: clamped, confirmedAt: ts, confirmedBy: userIdentity?.initials || "", confirmedColor: userIdentity?.color || C.green };
    setKiaInvoices(prev => prev.map(inv => {
      if (inv.id !== invoice.id) return inv;
      const parts = inv.parts.map((p, i) => i !== idx ? p : updatedPart);
      const done  = parts.every(p => p.short || p.confirmed >= p.qty);
      return { ...inv, parts, complete: done, completedAt: done && !inv.complete ? ts : (inv.completedAt || 0) };
    }));
    wsBroadcastPart(updatedPart, idx);
    showFeedback(`✓ Qty ${clamped} confirmed!`, C.green);
    setQtyModal(null);
    setQtyInput("");
  };

  const markShort = (idx, receivedQty) => {
    const ts = Date.now();
    Vibration.vibrate([0, 60, 60, 60]);
    const updatedPart = { ...invoice.parts[idx], short: true, shortQty: receivedQty, confirmed: receivedQty, confirmedAt: ts, confirmedBy: userIdentity?.initials || "", confirmedColor: userIdentity?.color || C.amber };
    setKiaInvoices(prev => prev.map(inv => {
      if (inv.id !== invoice.id) return inv;
      const parts = inv.parts.map((p, i) => i !== idx ? p : updatedPart);
      const done  = parts.every(p => p.short || p.confirmed >= p.qty);
      return { ...inv, parts, complete: done, completedAt: done && !inv.complete ? ts : (inv.completedAt || 0) };
    }));
    wsBroadcastPart(updatedPart, idx);
    showFeedback(`⚠ Short supply marked`, C.amber);
    setOverrideModal(null);
  };

  const handlePartScanned = (data) => {
    setShowScanner(false);
    scrollRef.current?.scrollTo({ y: 0, animated: true });
    const scanned  = String(data).trim().toUpperCase();
    const stripped = scanned.length > 2 ? scanned.slice(2) : scanned;
    const dashStripped      = scanned.replace(/-[A-Z0-9]{1,5}$/, '');
    const dashStrippedShort = stripped.replace(/-[A-Z0-9]{1,5}$/, '');
    const partMatch = p => {
      const pn = p.partNumber.toUpperCase();
      const pnNoDash = pn.replace(/-/g, "");
      return pn === scanned || pn === stripped || pn === dashStripped || pn === dashStrippedShort ||
             pnNoDash === scanned || pnNoDash === stripped;
    };
    // First unconfirmed line, fall back to first match
    let idx = invoice.parts.findIndex(p => partMatch(p) && !(p.short || p.confirmed >= p.qty));
    if (idx === -1) idx = invoice.parts.findIndex(p => partMatch(p));
    if (idx === -1) {
      Vibration.vibrate([0, 80, 80, 80]);
      showScanPopup("✕", "NOT FOUND", C.red, lastScanned?.partNumber);
      setLastScanned({ partNumber: scanned, status: "not_found" });
      return;
    }
    const part = invoice.parts[idx];
    if (part.short || part.confirmed >= part.qty) {
      showScanPopup("✓", "ALREADY DONE", C.amber, invoice.id);
      setLastScanned({ partNumber: part.partNumber, lineNo: part.lineNo, status: "already_done" });
      const cardKey = part.partNumber + part.lineNo;
      // Bump confirmedAt so it sorts to top of DONE column
      setKiaInvoices(prev => prev.map(inv => {
        if (inv.id !== invoice.id) return inv;
        return { ...inv, parts: inv.parts.map((p, i) => i !== idx ? p : { ...p, confirmedAt: Date.now() }) };
      }));
      // Wait for popup to clear then scroll + flash
      setTimeout(() => {
        const y = doneCardYRefs.current[cardKey];
        if (y !== undefined) {
          (doneScrollRef.current)?.scrollTo({ y: 0, animated: true });
        }
        setFlashPartKey(cardKey);
        setTimeout(() => setFlashPartKey(null), 1200);
      }, 1350);
      return;
    }
    if (part.qty > 1) {
      setQtyModal({ idx, partNumber: part.partNumber, expected: part.qty });
      setQtyInput("");
      setLastScanned({ partNumber: part.partNumber, lineNo: part.lineNo, status: "qty_needed" });
      return;
    }
    Vibration.vibrate(60);
    const _hts = Date.now();
    const updatedScanPart = { ...part, confirmed: 1, confirmedAt: _hts, confirmedBy: userIdentity?.initials || "", confirmedColor: userIdentity?.color || C.green };
    setKiaInvoices(prev => prev.map(inv => {
      if (inv.id !== invoice.id) return inv;
      const parts = inv.parts.map((p, i) => i !== idx ? p : updatedScanPart);
      const done  = parts.every(p => p.short || p.confirmed >= p.qty);
      return { ...inv, parts, complete: done, completedAt: done && !inv.complete ? _hts : (inv.completedAt || 0) };
    }));
    wsBroadcastPart(updatedScanPart, idx);
    setLastScanned({ partNumber: part.partNumber, lineNo: part.lineNo, status: "ok" });
    showScanPopup("✓", "CONFIRMED", C.green, invoice.id);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      {/* ── Header ── */}
      <View style={{ backgroundColor: C.s2, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: C.b1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <TouchableOpacity onPress={onBack} style={{ backgroundColor: C.s3, borderRadius: 10, padding: 8, borderWidth: 1, borderColor: C.b1 }}>
            <Ionicons name="arrow-back" size={20} color={C.t2} />
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          {/* Discreet reset icon — top right */}
          <TouchableOpacity
            onPress={() => {
              Alert.alert("Reset Invoice?", "This will clear all confirmed parts on this invoice.", [
                { text: "Cancel", style: "cancel" },
                { text: "Reset", style: "destructive", onPress: () => {
                  const ts = Date.now();
                  setKiaInvoices(prev => prev.map(inv =>
                    inv.id !== invoice.id ? inv : {
                      ...inv,
                      complete: false,
                      completedAt: 0,
                      parts: inv.parts.map(p => ({ ...p, confirmed: 0, short: false, shortQty: undefined, confirmedBy: "", confirmedColor: "", confirmedAt: 0 }))
                    }
                  ));
                  // Broadcast reset for every part + explicit invoice_reset to clear complete flag
                  if (wsRef?.current?.readyState === 1 && currentRoomId && userIdentity) {
                    invoice.parts.forEach(p => {
                      wsRef.current.send(JSON.stringify({
                        type: "part_update",
                        invId: invoice.id,
                        partKey: p.partNumber + "_" + (p.lineNo || "0"),
                        confirmed: 0, short: false, shortQty: 0,
                        initials: userIdentity.initials,
                        color: userIdentity.color,
                        userId: userIdentity.id,
                        timestamp: ts,
                      }));
                    });
                    // Send explicit reset so other phones clear the complete flag
                    wsRef.current.send(JSON.stringify({
                      type: "invoice_reset",
                      invId: invoice.id,
                      userId: userIdentity.id,
                      timestamp: ts,
                    }));
                  }
                  setLastScanned(null);
                }}
              ]);
            }}
            style={{ backgroundColor: C.s3, borderRadius: 10, padding: 8, borderWidth: 1, borderColor: C.b1 }}
            activeOpacity={0.7}>
            <MaterialCommunityIcons name="refresh" size={20} color={C.t2} />
          </TouchableOpacity>
        </View>

        {/* Always-visible banner: invoice + order + last scanned part (blank if none) */}
        {(() => {
          const chipColor = !lastScanned ? C.t3
            : lastScanned.status === "not_found" ? C.red
            : lastScanned.status === "ok" ? C.green
            : C.t3;
          const handleBannerTap = () => {
            if (!lastScanned) return;
            const part = invoice.parts.find(p =>
              p.partNumber === lastScanned.partNumber &&
              (lastScanned.lineNo === undefined || p.lineNo === lastScanned.lineNo)
            );
            if (!part) return;
            const cardKey = part.partNumber + part.lineNo;
            const colKey = allPartYRefs.current[cardKey]?.col || "done";
            const y = colKey === "done" ? doneCardYRefs.current[cardKey] : allPartYRefs.current[cardKey]?.y;
            if (y !== undefined) {
              allColScrollRefs.current[colKey]?.scrollTo({ y, animated: true });
            }
            setFlashPartKey(cardKey);
            setTimeout(() => setFlashPartKey(null), 1200);
          };
          const allParts = invoice.parts.filter(p => !p.short && p.qty > 0);
          const confirmedCount = allParts.filter(p => p.confirmed >= p.qty).length;
          const totalCount = allParts.length;
          const allDoneCounter = confirmedCount === totalCount && totalCount > 0;
          return (
            <TouchableOpacity onPress={handleBannerTap} activeOpacity={lastScanned ? 0.7 : 1}
              style={{ flexDirection: "row", marginTop: 10, borderRadius: 10, borderWidth: 1, borderColor: C.b1, overflow: "hidden", backgroundColor: C.s2, borderLeftWidth: 4, borderLeftColor: chipColor }}>
              {/* Left — big invoice number */}
              <View style={{ paddingVertical: 10, paddingHorizontal: 14, justifyContent: "center", minWidth: 110 }}>
                <Text style={{ color: C.t3, fontSize: 8, fontWeight: "900", letterSpacing: 1, marginBottom: 2 }}>LAST SCAN</Text>
                <Text style={{ color: C.t1, fontSize: 36, fontWeight: "900", lineHeight: 38, letterSpacing: -1 }} numberOfLines={1}>{invoice.id}</Text>
              </View>
              {/* Divider */}
              <View style={{ width: 1, backgroundColor: C.b1 }} />
              {/* Middle — part + order */}
              <View style={{ flex: 1, paddingVertical: 8, paddingHorizontal: 10, justifyContent: "center", gap: 5 }}>
                <View>
                  <Text style={{ color: C.t3, fontSize: 8, fontWeight: "900", letterSpacing: 1, marginBottom: 1 }}>PART</Text>
                  <Text style={{ color: lastScanned ? C.t2 : C.t3, fontSize: 13, fontWeight: "900" }} numberOfLines={1}>
                    {lastScanned ? lastScanned.partNumber : "—"}
                  </Text>
                </View>
                <View>
                  <Text style={{ color: C.t3, fontSize: 8, fontWeight: "900", letterSpacing: 1, marginBottom: 1 }}>ORDER</Text>
                  <Text style={{ color: C.t2, fontSize: 12, fontWeight: "700" }} numberOfLines={1}>{invoice.orderRef || "—"}</Text>
                </View>
              </View>
              {/* Right — counter */}
              <View style={{ paddingVertical: 8, paddingHorizontal: 12, justifyContent: "center", alignItems: "center", borderLeftWidth: 1, borderLeftColor: C.b1 }}>
                <Text style={{ color: C.t3, fontSize: 8, fontWeight: "900", letterSpacing: 1, marginBottom: 3 }}>DONE</Text>
                <Text style={{ color: allDoneCounter ? C.green : C.t1, fontSize: 20, fontWeight: "900", lineHeight: 22 }}>{confirmedCount}</Text>
                <View style={{ height: 1, backgroundColor: C.b1, width: "100%", marginVertical: 3 }} />
                <Text style={{ color: C.t3, fontSize: 16, fontWeight: "900", lineHeight: 18 }}>{totalCount}</Text>
              </View>
            </TouchableOpacity>
          );
        })()}

        {/* Feedback flash */}
        {feedback ? (
          <View style={{ marginTop: 8, backgroundColor: feedback.color + "22", borderRadius: 10, paddingVertical: 8, alignItems: "center", borderWidth: 1, borderColor: feedback.color + "44" }}>
            <Text style={{ color: feedback.color, fontSize: 14, fontWeight: "800" }}>{feedback.msg}</Text>
          </View>
        ) : null}


      </View>

      {/* ── 2-Column Triage ── */}
      <View style={{ flex: 1, flexDirection: "row" }}>
        {[
          { key: "pending", label: "PENDING", headerBg: C.red,   accent: C.red,   parts: allParts.filter(p => !(p.short || p.confirmed > 0)) },
          { key: "done",    label: "DONE",    headerBg: C.green, accent: C.green, parts: allParts.filter(p => p.short || p.confirmed > 0).sort((a, b) => {
            const aMatch = lastScanned && a.partNumber === lastScanned.partNumber;
            const bMatch = lastScanned && b.partNumber === lastScanned.partNumber;
            if (aMatch && !bMatch) return -1;
            if (bMatch && !aMatch) return 1;
            return (b.confirmedAt || 0) - (a.confirmedAt || 0);
          }) },
        ].map((col, colIdx) => (
          <View key={col.key} style={{ flex: 1, borderRightWidth: colIdx === 0 ? 1 : 0, borderRightColor: C.b1, flexDirection: "column" }}>
            {/* Column header — Focus Board style */}
            <View style={{ borderTopWidth: 3, borderTopColor: col.accent, paddingTop: 6, paddingBottom: 6, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={{ color: C.t3, fontSize: 9, fontWeight: "900", letterSpacing: 1 }}>{col.label}</Text>
              <Text style={{ color: C.t3, fontSize: 9, fontWeight: "900" }}>{col.parts.length}</Text>
            </View>

            {/* Cards */}
            <ScrollView ref={sv => { allColScrollRefs.current[col.key] = sv; if (col.key === "done") doneScrollRef.current = sv; }} contentContainerStyle={{ padding: 6, paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
              {col.parts.map((part) => {
                const realIdx = invoice.parts.indexOf(part);
                const done    = part.short || part.confirmed >= part.qty;
                return (
                  <TouchableOpacity
                    key={`${part.partNumber}-${part.lineNo}`}
                    activeOpacity={0.75}
                    onLayout={(e) => { const key = part.partNumber + part.lineNo; allPartYRefs.current[key] = { y: e.nativeEvent.layout.y, col: col.key }; if (col.key === "done") doneCardYRefs.current[key] = e.nativeEvent.layout.y; }}
                    onPress={() => { Vibration.vibrate(40); setOverrideModal({ idx: realIdx, partNumber: part.partNumber, qty: part.qty, done }); }}
                    style={{
                      backgroundColor: flashPartKey === part.partNumber + part.lineNo ? C.green + "33" : C.s2,
                      borderRadius: 8,
                      borderLeftWidth: 3,
                      borderLeftColor: flashPartKey === part.partNumber + part.lineNo ? C.green : part.short ? (part.shortQty === 0 ? C.red : C.amber) : (!part.short && part.confirmed > 0 && part.confirmed < part.qty) ? C.amber : col.accent,
                      padding: 10,
                      marginBottom: 6,
                      ...(part.short ? { backgroundColor: (part.shortQty === 0 ? C.red : C.amber) + "18" } : (!part.short && part.confirmed > 0 && part.confirmed < part.qty) ? { backgroundColor: C.amber + "18" } : {}),
                    }}>
                    <View style={{ flexDirection: "row", alignItems: "center" }}>
                      <Text style={{ color: part.short ? (part.shortQty === 0 ? C.red : C.amber) : (!part.short && part.confirmed > 0 && part.confirmed < part.qty) ? C.amber : col.accent, fontWeight: "900", fontSize: 18, letterSpacing: 0.3, flex: 1 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.4}>{part.partNumber}</Text>
                      <Ionicons name="chevron-forward" size={12} color={C.t3} />
                    </View>
                    {part.description ? <Text style={{ color: C.t3, fontSize: 11, marginTop: 2 }} numberOfLines={1}>{part.description}</Text> : null}
                    <View style={{ flexDirection: "row", alignItems: "center", marginTop: 4 }}>
                      <Text style={{ color: C.t3, fontSize: 11, flex: 1 }}>{part.qty}/{part.confirmed}</Text>
                      {part.confirmedBy ? <Text style={{ color: (part.confirmedColor||C.green)+"99", fontSize: 9, fontWeight: "700" }}>{part.confirmedBy} {fmtTime(part.confirmedAt)}</Text> : null}
                    </View>
                    {part.short && (
                      <View style={{ backgroundColor: (part.shortQty === 0 ? C.red : C.amber) + "22", borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, alignSelf: "flex-start", borderWidth: 1, borderColor: (part.shortQty === 0 ? C.red : C.amber) + "55", marginTop: 5 }}>
                        <Text style={{ color: part.shortQty === 0 ? C.red : C.amber, fontSize: 8, fontWeight: "900" }}>{part.shortQty === 0 ? "MISSING" : "SHORT"}</Text>
                      </View>
                    )}
                    {!part.short && part.confirmed > 0 && part.confirmed < part.qty && (
                      <View style={{ backgroundColor: C.amber + "22", borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, alignSelf: "flex-start", borderWidth: 1, borderColor: C.amber + "55", marginTop: 5 }}>
                        <Text style={{ color: C.amber, fontSize: 8, fontWeight: "900" }}>PARTIAL</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        ))}
      </View>

      {/* ── Bottom bar ── */}
      <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, backgroundColor: C.bg, borderTopWidth: 1, borderTopColor: C.b1, padding: 16, paddingBottom: Math.max(insets.bottom, 16) }}>
        {allDone ? (
          <TouchableOpacity
            onPress={() => {
              const _cts = Date.now();
              setKiaInvoices(prev => prev.map(inv => inv.id === invoice.id ? { ...inv, complete: true, completedAt: inv.completedAt || _cts } : inv));
              if (wsRef?.current?.readyState === 1 && currentRoomId && userIdentity) {
                wsRef.current.send(JSON.stringify({ type:"invoice_complete", invId:invoice.id, initials:userIdentity.initials, color:userIdentity.color, timestamp:_cts }));
              }
              onBack();
            }}
            style={{ backgroundColor: C.green, borderRadius: 18, paddingVertical: 24, alignItems: "center", shadowColor: C.green, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.4, shadowRadius: 16, elevation: 10 }}
            activeOpacity={0.85}>
            <Text style={{ color: C.bg, fontSize: 24, fontWeight: "900" }}>RECEIVING COMPLETE ✓</Text>
            <Text style={{ color: C.bg + "99", fontSize: 13, marginTop: 4 }}>All parts confirmed</Text>
          </TouchableOpacity>
        ) : (
          <View style={{ flexDirection: "row", gap: 10 }}>
            <TouchableOpacity
              onPress={() => setShowScanner(true)}
              style={{ flex: 1, backgroundColor: C.green, borderRadius: 18, paddingVertical: 28, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 12, shadowColor: C.green, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.4, shadowRadius: 16, elevation: 10 }}
              activeOpacity={0.85}>
              <MaterialCommunityIcons name="barcode-scan" size={40} color={C.bg} />
            </TouchableOpacity>
          </View>
        )}
      </View>


      {/* Override modal */}
      <Modal visible={!!overrideModal} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: "#00000088", justifyContent: "flex-end" }}>
          <View style={{ backgroundColor: C.s1, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 28 }}>
            <View style={{ alignSelf: "center", width: 40, height: 4, backgroundColor: C.b1, borderRadius: 2, marginBottom: 16 }} />
            <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 16 }}>
              <TouchableOpacity onPress={() => setOverrideModal(null)} activeOpacity={0.7}
                style={{ backgroundColor: C.s2, borderRadius: 10, padding: 8, borderWidth: 1, borderColor: C.b1, marginRight: 12 }}>
                <Ionicons name="arrow-back" size={20} color={C.t2} />
              </TouchableOpacity>
              <Text style={{ color: C.t1, fontSize: 17, fontWeight: "900", flex: 1 }}>Override</Text>
              <TouchableOpacity
                onPress={() => Linking.openURL(`https://www.google.com/search?tbm=isch&q=KIA+${overrideModal?.partNumber}`)}
                activeOpacity={0.7}
                style={{ backgroundColor: C.s3, borderRadius: 12, padding: 11, borderWidth: 1, borderColor: C.b1 }}
              >
                <Text style={{ fontSize: 16 }}>🔍</Text>
              </TouchableOpacity>
            </View>
            <View style={{ marginBottom: 2 }}>
              <Text style={{ color: C.t2, fontSize: 12, fontWeight: "700", letterSpacing: 1, marginBottom: 4 }}>PART</Text>
              <Text style={{ color: C.t1, fontSize: 19, fontWeight: "900", marginBottom: 2 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.4}>{overrideModal?.partNumber}</Text>
            </View>
            <Text style={{ color: C.t3, fontSize: 13, marginBottom: 24 }}>Hold-down override — barcode not working?</Text>

            <TouchableOpacity
              onPress={() => {
                const { idx, qty } = overrideModal;
                setOverrideModal(null);
                if (qty > 1) { setQtyModal({ idx, partNumber: overrideModal.partNumber, expected: qty }); setQtyInput(""); }
                else { confirmPart(idx, 1); }
              }}
              style={{ backgroundColor: C.green + "22", borderRadius: 14, padding: 18, marginBottom: 10, flexDirection: "row", alignItems: "center", gap: 14, borderWidth: 1.5, borderColor: C.green + "66" }}
              activeOpacity={0.8}>
              <MaterialCommunityIcons name="check-bold" size={24} color={C.green} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: C.green, fontSize: 16, fontWeight: "900" }}>Manual Confirm</Text>
                <Text style={{ color: C.t3, fontSize: 12, marginTop: 2 }}>Mark as received without scanning</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => {
                const { idx, qty } = overrideModal;
                setOverrideModal(null);
                setQtyModal({ idx, partNumber: overrideModal.partNumber, expected: qty, isShort: true });
                setQtyInput("");
              }}
              style={{ backgroundColor: C.amber + "22", borderRadius: 14, padding: 18, marginBottom: 10, flexDirection: "row", alignItems: "center", gap: 14, borderWidth: 1.5, borderColor: C.amber + "66" }}
              activeOpacity={0.8}>
              <MaterialCommunityIcons name="alert-outline" size={24} color={C.amber} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: C.amber, fontSize: 16, fontWeight: "900" }}>Mark Short Supply</Text>
                <Text style={{ color: C.t3, fontSize: 12, marginTop: 2 }}>Enter how many actually received</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => {
                const { idx } = overrideModal;
                setOverrideModal(null);
                Vibration.vibrate([0, 60, 60, 60]);
                const _mts = Date.now();
                const _mpart = invoice.parts[idx];
                const _mupdated = { ..._mpart, short: true, shortQty: 0, confirmed: 0,
                  confirmedAt: _mts, confirmedBy: userIdentity?.initials || "", confirmedColor: userIdentity?.color || C.red };
                setKiaInvoices(prev => prev.map(inv => {
                  if (inv.id !== invoice.id) return inv;
                  const parts = inv.parts.map((p, i) => i !== idx ? p : _mupdated);
                  const done  = parts.every(p => p.short || p.confirmed >= p.qty);
                  return { ...inv, parts, complete: done, completedAt: done && !inv.complete ? _mts : (inv.completedAt || 0) };
                }));
                // Broadcast mark-missing to all room members
                if (wsRef?.current?.readyState === 1 && currentRoomId && userIdentity) {
                  wsRef.current.send(JSON.stringify({
                    type: "part_update",
                    invId: invoice.id,
                    partKey: _mpart.partNumber + "_" + (_mpart.lineNo || "0"),
                    confirmed: 0, short: true, shortQty: 0,
                    initials: userIdentity.initials,
                    color: userIdentity.color,
                    userId: userIdentity.id,
                    timestamp: _mts,
                  }));
                }
                showFeedback("✕ Marked as missing", C.red);
              }}
              style={{ backgroundColor: C.red + "22", borderRadius: 14, padding: 18, marginBottom: 10, flexDirection: "row", alignItems: "center", gap: 14, borderWidth: 1.5, borderColor: C.red + "66" }}
              activeOpacity={0.8}>
              <MaterialCommunityIcons name="package-variant-remove" size={24} color={C.red} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: C.red, fontSize: 16, fontWeight: "900" }}>Mark as Missing</Text>
                <Text style={{ color: C.t3, fontSize: 12, marginTop: 2 }}>Part not in delivery at all</Text>
              </View>
            </TouchableOpacity>


              <TouchableOpacity
                onPress={() => {
                  const { idx } = overrideModal;
                  setOverrideModal(null);
                  const _uts = Date.now();
                  const _upart = invoice.parts[idx];
                  setKiaInvoices(prev => prev.map(inv => {
                    if (inv.id !== invoice.id) return inv;
                    const parts = inv.parts.map((p, i) => i !== idx ? p : { ...p, confirmed: 0, short: false, shortQty: null, confirmedBy: "", confirmedColor: "", confirmedAt: 0 });
                    return { ...inv, parts, complete: false };
                  }));
                  // Broadcast undo to all room members
                  if (wsRef?.current?.readyState === 1 && currentRoomId && userIdentity) {
                    wsRef.current.send(JSON.stringify({
                      type: "part_update",
                      invId: invoice.id,
                      partKey: _upart.partNumber + "_" + (_upart.lineNo || "0"),
                      confirmed: 0, short: false, shortQty: 0,
                      initials: userIdentity.initials,
                      color: userIdentity.color,
                      userId: userIdentity.id,
                      timestamp: _uts,
                    }));
                  }
                  showFeedback("↩ Reset to uncounted", C.amber);
                }}
                style={{ backgroundColor: C.s2, borderRadius: 14, padding: 18, marginBottom: 10, flexDirection: "row", alignItems: "center", gap: 14, borderWidth: 1.5, borderColor: C.b1 }}
                activeOpacity={0.8}>
                <MaterialCommunityIcons name="undo" size={24} color={C.t2} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: C.t1, fontSize: 16, fontWeight: "900" }}>Undo / Reset</Text>
                  <Text style={{ color: C.t3, fontSize: 12, marginTop: 2 }}>Mark back as not received</Text>
                </View>
              </TouchableOpacity>
            )}

            <TouchableOpacity onPress={() => setOverrideModal(null)} style={{ paddingVertical: 14, paddingHorizontal: 40, alignItems: "center", alignSelf: "center", minWidth: 120 }}>
              <Text style={{ color: C.t3, fontSize: 16, letterSpacing: 0.5 }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Qty pad modal — also handles short supply */}
      <Modal visible={!!qtyModal} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: "#00000088", justifyContent: "flex-end" }}>
          <View style={{ backgroundColor: C.s1, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 48 }}>
            <View style={{ alignSelf: "center", width: 40, height: 4, backgroundColor: C.b1, borderRadius: 2, marginBottom: 20 }} />
            <Text style={{ color: C.t2, fontSize: 13, fontWeight: "700", letterSpacing: 1, marginBottom: 4 }}>PART NUMBER</Text>
            <Text style={{ color: C.t1, fontSize: 20, fontWeight: "900", marginBottom: 4 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.4}>{qtyModal?.partNumber}</Text>
            <Text style={{ color: C.t3, fontSize: 14, marginBottom: 20 }}>{qtyModal?.isShort ? "Qty received (short):" : `Expected qty: ${qtyModal?.expected}`}</Text>
            <View style={{ backgroundColor: C.s2, borderRadius: 16, borderWidth: 2, borderColor: (qtyModal?.isShort ? C.amber : C.green) + "66", padding: 20, alignItems: "center", marginBottom: 16 }}>
              <Text style={{ color: C.t3, fontSize: 13, fontWeight: "700", marginBottom: 4 }}>{qtyModal?.isShort ? "RECEIVED QTY" : "CONFIRMING QTY"}</Text>
              <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 4 }}>
                <Text style={{ color: qtyModal?.isShort ? C.amber : C.green, fontSize: 52, fontWeight: "900", letterSpacing: 2 }}>{qtyInput || "0"}</Text>
                <Text style={{ color: C.t3, fontSize: 32, fontWeight: "700", marginBottom: 6 }}>/{qtyModal?.expected}</Text>
              </View>
            </View>
            {[["1","2","3"],["4","5","6"],["7","8","9"],["⌫","0","✓"]].map((row, ri) => (
              <View key={ri} style={{ flexDirection: "row", gap: 10, marginBottom: 10 }}>
                {row.map(key => {
                  const isConfirm = key === "✓"; const isBack = key === "⌫";
                  const accent = qtyModal?.isShort ? C.amber : C.green;
                  return (
                    <TouchableOpacity key={key} activeOpacity={0.7}
                      onPress={() => {
                        if (isConfirm) {
                          const n = parseInt(qtyInput) || 0;
                          if (n >= 0 && qtyModal) {
                            if (qtyModal.isShort) markShort(qtyModal.idx, n);
                            else confirmPart(qtyModal.idx, n);
                          }
                          setQtyModal(null); setQtyInput("");
                        } else if (isBack) { setQtyInput(q => q.slice(0, -1)); }
                        else { setQtyInput(q => q.length >= 3 ? q : q + key); }
                      }}
                      style={{ flex: 1, paddingVertical: 20, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: isConfirm ? accent : isBack ? C.s3 : C.s2, borderWidth: 1.5, borderColor: isConfirm ? accent : C.b1 }}>
                      <Text style={{ color: isConfirm ? C.bg : C.t1, fontSize: 24, fontWeight: "800" }}>{key}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ))}
            <TouchableOpacity onPress={() => { setQtyModal(null); setQtyInput(""); }} style={{ paddingVertical: 14, paddingHorizontal: 40, alignItems: "center", alignSelf: "center", minWidth: 120 }}>
              <Text style={{ color: C.t3, fontSize: 16, letterSpacing: 0.5 }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Confirm Part Popup */}
      {confirmPopup && (
        <Modal visible transparent animationType="slide">
          <TouchableOpacity style={{ flex: 1, backgroundColor: "#00000088" }} activeOpacity={1} onPress={() => setConfirmPopup(null)} />
          <View style={{ backgroundColor: C.s1, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 48 }}>
            <View style={{ alignSelf: "center", width: 40, height: 4, backgroundColor: C.b1, borderRadius: 2, marginBottom: 20 }} />
            <Text style={{ color: C.t3, fontSize: 10, fontWeight: "900", letterSpacing: 1.5, marginBottom: 6 }}>CONFIRM PART</Text>
            <Text style={{ color: C.t1, fontSize: 22, fontWeight: "900", marginBottom: 4 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.4}>{confirmPopup.partNumber}</Text>
            <Text style={{ color: C.t3, fontSize: 13, marginBottom: 16 }}>{confirmPopup.confirmed}/{confirmPopup.qty} confirmed</Text>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <TouchableOpacity onPress={() => setConfirmPopup(null)} activeOpacity={0.8}
                style={{ flex: 1, backgroundColor: C.s2, borderRadius: 14, paddingVertical: 18, alignItems: "center", borderWidth: 1, borderColor: C.b1 }}>
                <Text style={{ color: C.t2, fontSize: 16, fontWeight: "700" }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => {
                const { idx, qty } = confirmPopup;
                setConfirmPopup(null);
                if (qty > 1) { setQtyModal({ idx }); setQtyInput(""); }
                else confirmPart(idx, 1);
              }} activeOpacity={0.85}
                style={{ flex: 2, backgroundColor: C.green, borderRadius: 14, paddingVertical: 18, alignItems: "center" }}>
                <Text style={{ color: C.bg, fontSize: 16, fontWeight: "900" }}>Confirm</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}

      <BarcodeScanner visible={showScanner} title="Scan Part — KIA Receiving" onScanned={handlePartScanned} onClose={() => setShowScanner(false)} partsDB={invoice.parts.map(p => ({ partNumber: p.partNumber }))} torchEnabled={torchEnabled} />

      {/* Scan popup — Style 1 square */}
      {scanPopup ? (
        <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", backgroundColor: "#00000077" }}>
          <View style={{ width: 220, backgroundColor: scanPopup.color, borderRadius: 28, paddingVertical: 32, paddingHorizontal: 24, alignItems: "center" }}>
            <Text style={{ color: scanPopup.color === C.red ? "#fff" : "#07090F", fontSize: 72, fontWeight: "900", lineHeight: 76, marginBottom: 8 }}>{scanPopup.icon}</Text>
            <Text style={{ color: scanPopup.color === C.red ? "#fff" : "#07090F", fontSize: 22, fontWeight: "900", letterSpacing: 1 }}>{scanPopup.label}</Text>
            {scanPopup.sub ? <Text style={{ color: scanPopup.color === C.red ? "#ffffffAA" : "#07090F99", fontSize: 14, fontWeight: "700", marginTop: 6 }}>{scanPopup.sub}</Text> : null}
          </View>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

// ─── IDENTITY SETUP MODAL ─────────────────────────────────────────────────────
function IdentitySetupModal({ visible, onSave }) {
  const [nameInput, setNameInput] = useState("");
  const [initialsInput, setInitialsInput] = useState("");
  const [selectedColor, setSelectedColor] = useState(USER_COLORS[0]);
  const [error, setError] = useState("");

  function handleSave() {
    const name = nameInput.trim();
    const initials = initialsInput.trim().toUpperCase().slice(0,3);
    if (!name || !initials) { setError("Please enter your name and initials"); return; }
    onSave({ id: generateId(), name, initials, color: selectedColor });
  }

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={{ flex:1, backgroundColor:"rgba(0,0,0,0.85)", justifyContent:"center", alignItems:"center", padding:24 }}>
        <View style={{ backgroundColor:C.s2, borderRadius:20, padding:28, width:"100%", maxWidth:360 }}>
          <Text style={{ color:C.t1, fontSize:22, fontWeight:"700", marginBottom:6 }}>👋 Welcome!</Text>
          <Text style={{ color:C.t2, fontSize:14, marginBottom:24 }}>Set up your identity so others can see who confirmed each part.</Text>

          <Text style={{ color:C.t2, fontSize:13, marginBottom:6 }}>Your Name</Text>
          <TextInput
            value={nameInput}
            onChangeText={v => { setNameInput(v); setError(""); }}
            placeholder="e.g. Kaine"
            placeholderTextColor={C.t3}
            style={{ backgroundColor:C.s3, color:C.t1, borderRadius:10, padding:14, fontSize:16, marginBottom:16 }}
          />

          <Text style={{ color:C.t2, fontSize:13, marginBottom:6 }}>Your Initials (2–3 letters)</Text>
          <TextInput
            value={initialsInput}
            onChangeText={v => { setInitialsInput(v.toUpperCase().slice(0,3)); setError(""); }}
            placeholder="e.g. KL"
            placeholderTextColor={C.t3}
            maxLength={3}
            style={{ backgroundColor:C.s3, color:C.t1, borderRadius:10, padding:14, fontSize:20, fontWeight:"700", marginBottom:16 }}
          />

          <Text style={{ color:C.t2, fontSize:13, marginBottom:10 }}>Pick Your Colour</Text>
          <View style={{ flexDirection:"row", flexWrap:"wrap", gap:10, marginBottom:20 }}>
            {USER_COLORS.map(col => (
              <TouchableOpacity key={col} onPress={() => setSelectedColor(col)}
                style={{ width:36, height:36, borderRadius:18, backgroundColor:col,
                  borderWidth: selectedColor===col ? 3 : 0, borderColor:"#fff" }} />
            ))}
          </View>

          {!!error && <Text style={{ color:C.red, marginBottom:12, fontSize:13 }}>{error}</Text>}

          <TouchableOpacity onPress={handleSave}
            style={{ backgroundColor:C.green, borderRadius:12, padding:16, alignItems:"center" }}>
            <Text style={{ color:C.bg, fontWeight:"700", fontSize:16 }}>Save & Continue</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ─── BOARD SESSION MODAL ──────────────────────────────────────────────────────
function BoardSessionModal({ visible, onClose, userIdentity, wsRef, currentRoomId, setCurrentRoomId, setRoomName, setRoomMembers, setIsRoomHost, focusList, pinnedIds, setFocusList, setPinnedIds, setKiaInvoices, kiaInvoices }) {
  const [tab, setTab] = useState("create"); // "create" | "join"
  const [roomNameInput, setRoomNameInput] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [mergeMode, setMergeMode] = useState("merge"); // "merge" | "replace"
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showQR, setShowQR] = useState(false);
  const [createdRoomId, setCreatedRoomId] = useState(null);
  const [createdRoomName, setCreatedRoomName] = useState("");
  const [showQRScanner, setShowQRScanner] = useState(false);

  function wsSend(msg) {
    if (wsRef.current && wsRef.current.readyState === 1) wsRef.current.send(JSON.stringify(msg));
  }

  function handleCreate() {
    if (!roomNameInput.trim()) { setError("Enter a board name"); return; }
    const roomId = generateRoomCode();
    setLoading(true); setError("");
    wsSend({
      type: "create_room",
      roomId,
      roomName: roomNameInput.trim(),
      userId: userIdentity.id,
      initials: userIdentity.initials,
      color: userIdentity.color,
      name: userIdentity.name,
      focusList,
      pinnedIds,
      invoices: kiaInvoices || [],  // Send ALL invoices so joiners get full state
    });
    setCreatedRoomId(roomId);
    setCreatedRoomName(roomNameInput.trim());
    setCurrentRoomId(roomId);
    setRoomName(roomNameInput.trim());
    setLoading(false);
    setShowQR(true);
  }

  function handleJoin() {
    const code = joinCode.trim().toUpperCase();
    if (!code) { setError("Enter a board code"); return; }
    setLoading(true); setError("");
    wsSend({
      type: "join_room",
      roomId: code,
      userId: userIdentity.id,
      initials: userIdentity.initials,
      color: userIdentity.color,
      name: userIdentity.name,
      mergeMode,
    });
    setCurrentRoomId(code);
    setLoading(false);
    onClose();
  }

  function handleLeave() {
    wsSend({ type: "leave_room", userId: userIdentity.id });
    setCurrentRoomId(null);
    setRoomName(null);
    setRoomMembers([]);
    setIsRoomHost(false);
    setShowQR(false);
    setCreatedRoomId(null);
    setCreatedRoomName("");
    onClose();
  }

  if (showQR && createdRoomId) {
    return (
      <Modal visible={visible} transparent animationType="slide">
        <View style={{ flex:1, backgroundColor:"rgba(0,0,0,0.9)", justifyContent:"center", alignItems:"center", padding:24 }}>
          <View style={{ backgroundColor:C.s2, borderRadius:20, padding:28, width:"100%", maxWidth:360, alignItems:"center" }}>
            <Text style={{ color:C.t1, fontSize:20, fontWeight:"700", marginBottom:4 }}>Board Created! 🎉</Text>
            <Text style={{ color:C.t2, fontSize:14, marginBottom:20 }}>{createdRoomName}</Text>

            {/* Simple QR-like display — show room code large for others to type, plus QR via web service */}
            <View style={{ backgroundColor:C.s3, borderRadius:16, padding:20, alignItems:"center", marginBottom:16, width:"100%" }}>
              <Text style={{ color:C.t2, fontSize:12, marginBottom:8 }}>BOARD CODE</Text>
              <Text style={{ color:C.green, fontSize:32, fontWeight:"900", letterSpacing:4 }}>{createdRoomId}</Text>
            </View>

            {/* QR code image via free API */}
            <Image
              source={{ uri: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(createdRoomId)}&bgcolor=07090F&color=00E676&margin=10` }}
              style={{ width:200, height:200, borderRadius:12, marginBottom:20 }}
            />

            <Text style={{ color:C.t2, fontSize:13, textAlign:"center", marginBottom:20 }}>
              Others tap "Join Board" on their app and scan this QR or type the code above.
            </Text>

            <TouchableOpacity onPress={onClose}
              style={{ backgroundColor:C.green, borderRadius:12, padding:14, width:"100%", alignItems:"center", marginBottom:10 }}>
              <Text style={{ color:C.bg, fontWeight:"700", fontSize:16 }}>Done — I'm the Host 👑</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleLeave}
              style={{ backgroundColor:"transparent", borderRadius:12, padding:12, width:"100%", alignItems:"center", borderWidth:1, borderColor:C.red+"66" }}>
              <Text style={{ color:C.red, fontWeight:"700", fontSize:14 }}>Leave Board</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  }

  if (currentRoomId) {
    return (
      <Modal visible={visible} transparent animationType="slide">
        <View style={{ flex:1, backgroundColor:"rgba(0,0,0,0.85)", justifyContent:"center", alignItems:"center", padding:24 }}>
          <View style={{ backgroundColor:C.s2, borderRadius:20, padding:24, width:"100%", maxWidth:360 }}>
            <Text style={{ color:C.t1, fontSize:18, fontWeight:"700", marginBottom:16 }}>You're in a shared board</Text>
            <Text style={{ color:C.t2, marginBottom:8 }}>Room: <Text style={{ color:C.green }}>{currentRoomId}</Text></Text>
            <TouchableOpacity onPress={handleLeave}
              style={{ backgroundColor:C.red, borderRadius:12, padding:14, alignItems:"center", marginTop:12 }}>
              <Text style={{ color:"#fff", fontWeight:"700" }}>Leave Board</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose} style={{ padding:14, alignItems:"center" }}>
              <Text style={{ color:C.t2 }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={{ flex:1, backgroundColor:"rgba(0,0,0,0.85)", justifyContent:"center", alignItems:"center", padding:24 }}>
        <View style={{ backgroundColor:C.s2, borderRadius:20, padding:24, width:"100%", maxWidth:360 }}>
          <Text style={{ color:C.t1, fontSize:20, fontWeight:"700", marginBottom:16 }}>Share Focus Board</Text>

          {/* Tabs */}
          <View style={{ flexDirection:"row", backgroundColor:C.s3, borderRadius:10, padding:4, marginBottom:20 }}>
            {["create","join"].map(t => (
              <TouchableOpacity key={t} onPress={() => { setTab(t); setError(""); }}
                style={{ flex:1, padding:10, borderRadius:8, alignItems:"center",
                  backgroundColor: tab===t ? C.b1 : "transparent" }}>
                <Text style={{ color: tab===t ? C.t1 : C.t2, fontWeight:"600", textTransform:"capitalize" }}>
                  {t === "create" ? "Create Board" : "Join Board"}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {tab === "create" ? (
            <>
              <Text style={{ color:C.t2, fontSize:13, marginBottom:6 }}>Board Name</Text>
              <TextInput
                value={roomNameInput}
                onChangeText={v => { setRoomNameInput(v); setError(""); }}
                placeholder="e.g. Morning Shift, Bay 1"
                placeholderTextColor={C.t3}
                style={{ backgroundColor:C.s3, color:C.t1, borderRadius:10, padding:14, fontSize:15, marginBottom:16 }}
              />
              {!!error && <Text style={{ color:C.red, marginBottom:10, fontSize:13 }}>{error}</Text>}
              <TouchableOpacity onPress={handleCreate} disabled={loading}
                style={{ backgroundColor:C.green, borderRadius:12, padding:14, alignItems:"center" }}>
                <Text style={{ color:C.bg, fontWeight:"700", fontSize:16 }}>Create & Share QR</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={{ color:C.t2, fontSize:13, marginBottom:6 }}>Enter Board Code or Scan QR</Text>
              <View style={{ flexDirection:"row", gap:8, marginBottom:16 }}>
                <TextInput value={joinCode} onChangeText={v=>{setJoinCode(v.toUpperCase());setError("");}} placeholder="e.g. KIA-7B3F2A" placeholderTextColor={C.t3} autoCapitalize="characters" style={{ flex:1, backgroundColor:C.s3, color:C.t1, borderRadius:10, padding:14, fontSize:16, fontWeight:"700", letterSpacing:2 }} />
                <TouchableOpacity onPress={()=>setShowQRScanner(true)} style={{ backgroundColor:C.s3, borderRadius:10, padding:14, alignItems:"center", justifyContent:"center", borderWidth:1, borderColor:C.green+"66" }}>
                  <MaterialCommunityIcons name="qrcode-scan" size={26} color={C.green} />
                </TouchableOpacity>
              </View>
              {showQRScanner&&(<Modal visible animationType="slide"><View style={{flex:1,backgroundColor:"#000"}}><CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{barcodeTypes:["qr"]}} onBarcodeScanned={({data})=>{const code=data.trim().toUpperCase();if(code.startsWith("KIA-")&&code.length>=8){setJoinCode(code);setShowQRScanner(false);}}}/><View style={{position:"absolute",top:0,left:0,right:0,backgroundColor:"#000000AA",paddingTop:52,paddingBottom:18,paddingHorizontal:24,flexDirection:"row",alignItems:"center",gap:14}}><Text style={{color:C.green,fontSize:22,fontWeight:"900",flex:1}}>Scan Board QR</Text><TouchableOpacity onPress={()=>setShowQRScanner(false)} style={{padding:8}}><Ionicons name="close" size={28} color={C.t1}/></TouchableOpacity></View><View style={{position:"absolute",bottom:60,left:0,right:0,alignItems:"center"}}><Text style={{color:C.t2,fontSize:14}}>Point at the QR code on Device 1</Text></View></View></Modal>)}

              <Text style={{ color:C.t2, fontSize:13, marginBottom:8 }}>When joining:</Text>
              <View style={{ flexDirection:"row", gap:8, marginBottom:16 }}>
                {[{k:"merge",label:"Merge boards"},{k:"replace",label:"Replace my board"}].map(opt => (
                  <TouchableOpacity key={opt.k} onPress={() => setMergeMode(opt.k)}
                    style={{ flex:1, padding:10, borderRadius:10, alignItems:"center",
                      backgroundColor: mergeMode===opt.k ? C.b1 : C.s3,
                      borderWidth: mergeMode===opt.k ? 1 : 0, borderColor: C.green }}>
                    <Text style={{ color: mergeMode===opt.k ? C.green : C.t2, fontSize:13, fontWeight:"600" }}>{opt.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {!!error && <Text style={{ color:C.red, marginBottom:10, fontSize:13 }}>{error}</Text>}
              <TouchableOpacity onPress={handleJoin} disabled={loading}
                style={{ backgroundColor:C.blue, borderRadius:12, padding:14, alignItems:"center" }}>
                <Text style={{ color:C.bg, fontWeight:"700", fontSize:16 }}>Join Board</Text>
              </TouchableOpacity>
            </>
          )}

          <TouchableOpacity onPress={onClose} style={{ padding:14, alignItems:"center" }}>
            <Text style={{ color:C.t2 }}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ─── PRESENCE BAR ─────────────────────────────────────────────────────────────
function PresenceBar({ members, userIdentity, currentRoomId, roomName, isHost, onKick, onOpenSession }) {
  if (!currentRoomId || members.length === 0) return null;
  return (
    <View style={{ backgroundColor:C.s3, paddingHorizontal:12, paddingVertical:6,
      flexDirection:"row", alignItems:"center", gap:6, flexWrap:"wrap",
      borderRadius:10, borderWidth:1, borderColor:C.b1, marginTop:6 }}>
      <TouchableOpacity onPress={onOpenSession} style={{ flexDirection:"row", alignItems:"center", gap:4 }}>
        <MaterialCommunityIcons name="account-group" size={13} color={C.green} />
        <Text style={{ color:C.green, fontSize:11, fontWeight:"800" }}>{roomName || currentRoomId}</Text>
        <Text style={{ color:C.t3, fontSize:11 }}> •</Text>
      </TouchableOpacity>
      {members.map(m => {
        const isMe = m.id === userIdentity?.id;
        return (
          <TouchableOpacity key={m.id} onLongPress={() => isHost && !isMe && onKick(m.id)} activeOpacity={0.7}>
            <View style={{ flexDirection:"row", alignItems:"center", gap:3,
              backgroundColor: isMe ? m.color+"22" : "transparent",
              borderRadius:6, paddingHorizontal:5, paddingVertical:2,
              borderWidth: isMe ? 1 : 0, borderColor: m.color+"44" }}>
              {m.isHost && <Text style={{ fontSize:10 }}>👑</Text>}
              <View style={{ width:7, height:7, borderRadius:4, backgroundColor: m.connected ? m.color : C.t3 }} />
              <Text style={{ color: m.connected ? m.color : C.t3, fontSize:12, fontWeight:"900" }}>
                {m.initials}{isMe ? " (you)" : ""}
              </Text>
            </View>
          </TouchableOpacity>
        );
      })}
      {isHost && <Text style={{ color:C.green+"99", fontSize:10, marginLeft:"auto" }}>HOST</Text>}
    </View>
  );
}

// ─── KIA FOCUS BOARD ─────────────────────────────────────────────────────────
function KiaFocusBoard({ invoices, allInvoices, focusList, onSelect, onBack, torchEnabled, setKiaInvoices, lastScanned, setLastScanned, pinnedIds, setPinnedIds, activeInvId, setActiveInvId, pileCount, setPileCount, hideOrderRefs, setHideOrderRefs, suppressNewInvAlert, setSuppressNewInvAlert, dimOtherCards, setDimOtherCards, lastVisitedId, setLastVisitedId, onFindPart, onFindPartOcr, onFindPartKeyboard, hideFindBtn,
  userIdentity, wsRef, currentRoomId, roomName, roomMembers, setRoomMembers, isRoomHost, onOpenSession, incomingJoinReq, onRespondJoinReq }) {
  const insets = useSafeAreaInsets();
  const [boardRefreshing, setBoardRefreshing] = React.useState(false);

  // Swipe-down: send request_sync to server → server merges everyone's state → broadcasts full_sync to ALL
  const handleBoardRefresh = () => {
    if (!currentRoomId || !userIdentity) { setBoardRefreshing(false); return; }
    setBoardRefreshing(true);
    if (wsRef?.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type: "request_sync", userId: userIdentity.id }));
    }
    // Stop spinner after 1.5s — full_sync response will update the board silently
    setTimeout(() => setBoardRefreshing(false), 1500);
  };

  // WS keepalive ping every 8s
  React.useEffect(() => {
    if (!currentRoomId || !userIdentity) return;
    const interval = setInterval(() => {
      if (wsRef?.current?.readyState === 1)
        wsRef.current.send(JSON.stringify({ type:"presence_ping", roomId:currentRoomId, userId:userIdentity.id }));
    }, 8000);
    return () => clearInterval(interval);
  }, [currentRoomId, userIdentity]);
  const [boardScanMode, setBoardScanMode] = useState(false);
  const [scanPopup, setScanPopup]         = useState(null);
  const [qtyModal, setQtyModal]           = useState(null);
  const [qtyInput, setQtyInput]           = useState("");
  const [flashId, setFlashId]             = useState(null);
  const [multiMatch, setMultiMatch]       = useState(null); // { scanned, matches: [{inv, idx}] }
  const [boardToolsVisible, setBoardToolsVisible] = useState(false);
  const [selectedBoardIds, setSelectedBoardIds] = useState([]);
  const [boardSelectMode, setBoardSelectMode] = useState(false);
  const [toolsTab, setToolsTab]           = useState("board"); // "board" | "csv"
  const [toolsOrderFilter, setToolsOrderFilter] = useState("");
  const [toolsInvFilter, setToolsInvFilter]     = useState("");
  const [pileSwitch, setPileSwitch]       = useState(null); // { fromId, toId } shown briefly
  const [removeCardModal, setRemoveCardModal] = useState(null); // inv object
  const [boardMultiSelectIds, setBoardMultiSelectIds] = useState([]); // direct board multi-select
  const colScrollRefs = useRef({}); // { pending: ref, inprogress: ref, complete: ref }
  const cardYRefs = useRef({}); // { invId: y position }
  const [newInvAlert, setNewInvAlert]     = useState(null); // { fromId, toId }
  const [completeAlert, setCompleteAlert]   = useState(null); // { invId, orderRef, partCount }
  const pendingCompleteRef = useRef(null); // complete alert queued behind new invoice alert
  const _scanSwipeY = useRef(0);
  const _scanSwipeX = useRef(0);
  const _scanSwiped = useRef(false);
  const _scanHeld = useRef(false);
  const _scanHoldTimer = useRef(null);
  const [scanArmed, setScanArmed] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const _scanProgressInterval = useRef(null);
  const [bannerHidden, setBannerHidden] = useState(false);

  // ── Triage column config ──────────────────────────────────────────────────────
  const TRIAGE_COLS = [
    { key: "pending",    label: "PENDING",     num: "1", headerBg: C.red,   accent: C.red   },
    { key: "inprogress", label: "IN PROGRESS", num: "2", headerBg: C.amber, accent: C.amber },
    { key: "complete",   label: "COMPLETE",    num: "3", headerBg: C.green, accent: C.green },
  ];

  const showScanPopup = (icon, label, color, invId) => {
    setScanPopup({ icon, label, color, invId });
    setTimeout(() => setScanPopup(null), 1200);
  };

  const flashCard = (invId) => {
    // Scroll to card first, then flash
    const stage = byStage.pending.some(i => i.id === invId) ? "pending"
      : byStage.inprogress.some(i => i.id === invId) ? "inprogress"
      : byStage.complete.some(i => i.id === invId) ? "complete" : null;
    if (stage && colScrollRefs.current[stage] && cardYRefs.current[invId] !== undefined) {
      colScrollRefs.current[stage].scrollTo({ y: cardYRefs.current[invId], animated: true });
    }
    setFlashId(invId);
    setTimeout(() => setFlashId(null), 1000);
  };

  const autoConfirmPart = (raw) => {
    setBoardScanMode(false);
    const scanned      = String(raw).trim().toUpperCase();
    const stripped     = scanned.length > 2 ? scanned.slice(2) : scanned;
    const dashStripped = scanned.replace(/-[A-Z0-9]{1,5}$/, '');
    const dashStrippedShort = stripped.replace(/-[A-Z0-9]{1,5}$/, '');

    // Check IN PROGRESS first, then PENDING (newest date first) — prefer first unconfirmed line
    const inProgress = focused.filter(inv => getStatus(inv) === "inprogress");
    const pending    = focused.filter(inv => !inv.removedFromBoard && getStatus(inv) === "pending" && (inv.manuallyAdded || (inv.invDate || 0) >= pendingCutoff)).sort((a, b) => { const n = s => parseInt(s.id.replace(/\D/g,"")) || 0; return n(b) - n(a); });
    const scanOrder  = [...inProgress, ...pending, ...focused.filter(inv => getStatus(inv) === "complete")];
    // Exact part matcher — also handles DB parts with dashes (e.g. 583022SA10-DS) vs
    // barcode delivering dash-stripped version (583022SA10DS)
    const exactMatch = (scanStr) => (p) => {
      const pn     = p.partNumber.toUpperCase();
      const pnNoDash = pn.replace(/-/g, "");
      const s      = scanStr.toUpperCase();
      return pn === s || pnNoDash === s;
    };

    const exactPartMatch = (p) =>
      exactMatch(scanned)(p) ||
      exactMatch(stripped)(p) ||
      exactMatch(dashStripped)(p) ||
      exactMatch(dashStrippedShort)(p);

    // Fuzzy fallback — only used when ZERO exact matches found anywhere
    // ONE safe direction only: scanned barcode is LONGER than DB part (barcode has extra chars around it)
    // Never match when DB part is longer than scanned — prevents 263202R001 hitting 263202R001WK
    const fuzzyMatch = (scanStr) => (p) => {
      const pn = p.partNumber.toUpperCase();
      const s  = scanStr.toUpperCase();
      if (s.length > pn.length && s.includes(pn) && pn.length >= 7) return true;
      return false;
    };

    const fuzzyPartMatch = (p) =>
      fuzzyMatch(scanned)(p) ||
      fuzzyMatch(stripped)(p) ||
      fuzzyMatch(dashStripped)(p) ||
      fuzzyMatch(dashStrippedShort)(p);

    // Try exact across ALL scan order first; fuzzy only if zero exact hits
    const buildMatches = (order, matchFn) => {
      const result = [];
      for (const inv of order) {
        // Only include invoices that still have an UNCONFIRMED line for this part
        const idx = inv.parts.findIndex(p => matchFn(p) && !(p.short || p.confirmed >= p.qty));
        if (idx !== -1) {
          // Collect ALL unconfirmed indices for this part on this invoice
          const allIdx = inv.parts.reduce((acc, p, i) => {
            if (matchFn(p) && !(p.short || p.confirmed >= p.qty)) acc.push(i);
            return acc;
          }, []);
          result.push({ inv, idx, allIdx });
        }
      }
      return result;
    };

    let matches = buildMatches(scanOrder, exactPartMatch);
    if (matches.length === 0) matches = buildMatches(scanOrder, fuzzyPartMatch);

    if (matches.length === 0) {
      Vibration.vibrate([0, 80, 80, 80]);

      // Check if part exists on board invoices but is already fully confirmed
      const alreadyDoneOnBoard = focused.some(f => {
        const inv = invoices.find(i => i.id === f.id);
        if (!inv) return false;
        return inv.parts.some(p => (exactPartMatch(p) || fuzzyPartMatch(p)) && (p.short || p.confirmed >= p.qty));
      });
      if (alreadyDoneOnBoard) {
        // Find the most recently confirmed invoice that has this part done
        let bestInvId = null;
        let bestTime = -1;
        for (const f of focused) {
          const inv = invoices.find(i => i.id === f.id);
          if (!inv) continue;
          const matchPart = inv.parts.find(p => (exactPartMatch(p) || fuzzyPartMatch(p)) && (p.short || p.confirmed >= p.qty));
          if (matchPart) {
            const t = matchPart.confirmedAt || 0;
            if (t > bestTime) { bestTime = t; bestInvId = inv.id; }
          }
        }
        showScanPopup("✓", "ALREADY DONE", C.amber, null);
        if (bestInvId) setTimeout(() => flashCard(bestInvId), 400);
        return;
      }

      // Check outside focus board
      const outsideMatches = [];
      for (const inv of invoices) {
        if (focused.find(f => f.id === inv.id)) continue;
        let idx = inv.parts.findIndex(p => exactPartMatch(p) && !(p.short || p.confirmed >= p.qty));
        if (idx === -1) idx = inv.parts.findIndex(p => exactPartMatch(p));
        if (idx === -1) idx = inv.parts.findIndex(p => fuzzyPartMatch(p) && !(p.short || p.confirmed >= p.qty));
        if (idx === -1) idx = inv.parts.findIndex(p => fuzzyPartMatch(p));
        if (idx !== -1) outsideMatches.push({ inv, idx });
      }
      if (outsideMatches.length > 0) {
        const partNumber = outsideMatches[0].inv.parts[outsideMatches[0].idx].partNumber;
        setMultiMatch({ scanned, partNumber, matches: outsideMatches, outsideBoard: true });
      } else {
        showScanPopup("✕", "NOT FOUND", C.red, null);
      }
      return;
    }

    // Multiple invoices have this part — ask user which one
    if (matches.length > 1) {
      const partNumber = matches[0].inv.parts[matches[0].idx].partNumber;
      const inProgressMatches = matches.filter(m => getStatus(m.inv) === "inprogress");

      // Exactly 1 IN PROGRESS match → auto-confirm, skip picker
      if (inProgressMatches.length === 1) {
        confirmMatch(inProgressMatches[0].inv, inProgressMatches[0].idx, scanned);
        return;
      }

      // 2+ IN PROGRESS → show picker with only IN PROGRESS options
      if (inProgressMatches.length > 1) {
        setMultiMatch({ scanned, partNumber, matches: inProgressMatches });
        return;
      }

      // No IN PROGRESS → show full picker sorted by invoice number desc
      const sorted = [...matches].sort((a, b) => {
        const n = s => parseInt(s.inv.id.replace(/\D/g, "")) || 0;
        return n(b) - n(a);
      });
      setMultiMatch({ scanned, partNumber, matches: sorted });
      return;
    }

    // Single match — confirm as normal
    confirmMatch(matches[0].inv, matches[0].idx, scanned);
  };

  const persistDetailLastScanned = (invId, partNumber, status = "ok") => {
    const key = `@kia_lastscanned_detail_${invId}`;
    AsyncStorage.setItem(key, JSON.stringify({ partNumber, status })).catch(() => {});
  };

  const confirmMatch = (matchInv, matchIdx, scanned) => {
    setMultiMatch(null);
    const part = matchInv.parts[matchIdx];

    if (part.short || part.confirmed >= part.qty) {
      showScanPopup("✓", "ALREADY DONE", C.amber, matchInv.id);
      return;
    }

    if (part.qty > 1) {
      setQtyModal({ invId: matchInv.id, partIdx: matchIdx, partNumber: part.partNumber, expected: part.qty });
      setQtyInput("");
      setLastScanned({ partNumber: part.partNumber, invId: matchInv.id });
      persistDetailLastScanned(matchInv.id, part.partNumber);
      return;
    }

    Vibration.vibrate(60);
    persistDetailLastScanned(matchInv.id, part.partNumber);
    let justCompleted = null;
    const _ts = Date.now();
    const _pws = { partNumber: part.partNumber, lineNo: part.lineNo };
    setKiaInvoices(prev => prev.map(inv => {
      if (inv.id !== matchInv.id) return inv;
      const parts = inv.parts.map((p, i) => i !== matchIdx ? p : { ...p, confirmed: 1, confirmedAt: _ts, confirmedBy: userIdentity?.initials || "", confirmedColor: userIdentity?.color || C.green });
      const done  = parts.every(p => p.short || p.confirmed >= p.qty);
      if (done && !inv.complete) justCompleted = { invId: inv.id, orderRef: inv.orderRef, partCount: parts.length };
      return { ...inv, parts, complete: done, completedAt: done && !inv.complete ? _ts : (inv.completedAt || 0) };
    }));
    if (wsRef?.current?.readyState === 1 && currentRoomId && userIdentity) {
      wsRef.current.send(JSON.stringify({ type:"part_update", invId:matchInv.id, partKey:_pws.partNumber+"_"+(_pws.lineNo||"0"), confirmed:1, short:false, shortQty:0, initials:userIdentity.initials, color:userIdentity.color, userId:userIdentity.id, timestamp:_ts }));
    }
    // Pile counter logic — chain complete alert after new invoice alert if both fire
    setActiveInvId(prev => {
      if (prev === matchInv.id) {
        setPileCount(c => c + 1);
        // Same invoice — show complete immediately if applicable
        if (justCompleted) setTimeout(() => setCompleteAlert(justCompleted), 500);
      } else {
        if (prev !== null) {
          Vibration.vibrate(400);
          setPileSwitch({ fromId: prev, toId: matchInv.id });
          setTimeout(() => setPileSwitch(null), 1200);
          if (!suppressNewInvAlert) {
            setNewInvAlert({ fromId: prev, toId: matchInv.id });
            // Queue complete alert to show after user dismisses new invoice alert
            if (justCompleted) { pendingCompleteRef.current = justCompleted; }
          } else if (justCompleted) {
            setTimeout(() => setCompleteAlert(justCompleted), 500);
          }
        } else if (justCompleted) {
          setTimeout(() => setCompleteAlert(justCompleted), 500);
        }
        setPileCount(1);
      }
      return matchInv.id;
    });
    // Only show CONFIRMED popup if the invoice is NOT complete — complete popup handles that
    if (!justCompleted) showScanPopup("✓", "CONFIRMED", C.green, matchInv.id);
    setLastScanned({ partNumber: scanned || part.partNumber, invId: matchInv.id });
    if (setLastVisitedId) setLastVisitedId(matchInv.id);
    setTimeout(() => flashCard(matchInv.id), 1300);
  };

  const confirmAllLines = (matchInv, allIdx, scanned) => {
    setMultiMatch(null);
    Vibration.vibrate(60);
    const _ts = Date.now();
    const _pws = allIdx.map(i => ({ partNumber: matchInv.parts[i].partNumber, lineNo: matchInv.parts[i].lineNo, qty: matchInv.parts[i].qty }));
    setKiaInvoices(prev => prev.map(inv => {
      if (inv.id !== matchInv.id) return inv;
      const parts = inv.parts.map((p, i) => allIdx.includes(i) ? { ...p, confirmed: p.qty, confirmedAt: _ts, confirmedBy: userIdentity?.initials || "", confirmedColor: userIdentity?.color || C.green } : p);
      const done = parts.every(p => p.short || p.confirmed >= p.qty);
      return { ...inv, parts, complete: done, completedAt: done && !inv.complete ? _ts : (inv.completedAt || 0) };
    }));
    if (wsRef?.current?.readyState === 1 && currentRoomId && userIdentity) {
      _pws.forEach(p => wsRef.current.send(JSON.stringify({ type:"part_update", invId:matchInv.id, partKey:p.partNumber+"_"+(p.lineNo||"0"), confirmed:p.qty, short:false, shortQty:0, initials:userIdentity.initials, color:userIdentity.color, userId:userIdentity.id, timestamp:_ts })));
    }
    setActiveInvId(prev => {
      if (prev !== matchInv.id) {
        if (prev !== null) {
          Vibration.vibrate(400);
          setPileSwitch({ fromId: prev, toId: matchInv.id });
          setTimeout(() => setPileSwitch(null), 1200);
          if (!suppressNewInvAlert) setNewInvAlert({ fromId: prev, toId: matchInv.id });
        }
        setPileCount(allIdx.length);
      } else {
        setPileCount(c => c + allIdx.length);
      }
      return matchInv.id;
    });
    const totalQty = allIdx.reduce((s, i) => s + matchInv.parts[i].qty, 0);
    showScanPopup("✓", `ALL ${totalQty} CONFIRMED`, C.green, matchInv.id);
    setLastScanned({ partNumber: scanned || matchInv.parts[allIdx[0]].partNumber, invId: matchInv.id });
    persistDetailLastScanned(matchInv.id, scanned || matchInv.parts[allIdx[0]].partNumber);
    setTimeout(() => flashCard(matchInv.id), 1300);
  };

  const applyQtyConfirm = () => {
    if (!qtyModal) return;
    const qty = parseInt(qtyInput) || 0;
    if (qty <= 0) return;
    const clamped = Math.min(qty, qtyModal.expected);
    Vibration.vibrate(60);
    const _ts = Date.now();
    const _pws = { invId: qtyModal.invId, partNumber: qtyModal.partNumber, lineNo: qtyModal.lineNo };
    setKiaInvoices(prev => prev.map(inv => {
      if (inv.id !== qtyModal.invId) return inv;
      const parts = inv.parts.map((p, i) => i !== qtyModal.partIdx ? p : { ...p, confirmed: clamped, confirmedAt: _ts, confirmedBy: userIdentity?.initials || "", confirmedColor: userIdentity?.color || C.green });
      const done  = parts.every(p => p.short || p.confirmed >= p.qty);
      return { ...inv, parts, complete: done, completedAt: done && !inv.complete ? _ts : (inv.completedAt || 0) };
    }));
    if (wsRef?.current?.readyState === 1 && currentRoomId && userIdentity) {
      wsRef.current.send(JSON.stringify({ type:"part_update", invId:_pws.invId, partKey:_pws.partNumber+"_"+(_pws.lineNo||"0"), confirmed:clamped, short:false, shortQty:0, initials:userIdentity.initials, color:userIdentity.color, userId:userIdentity.id, timestamp:_ts }));
    }
    showScanPopup("✓", `Qty ${clamped} confirmed`, C.green, qtyModal.invId);
    const flashTarget = qtyModal.invId;
    const scannedPN   = qtyModal.partNumber;
    setActiveInvId(prev => {
      if (prev === flashTarget) { setPileCount(c => c + 1); }
      else { if (prev !== null) { Vibration.vibrate(400); setPileSwitch({ fromId: prev, toId: flashTarget }); setTimeout(() => setPileSwitch(null), 1200); if (!suppressNewInvAlert) setNewInvAlert({ fromId: prev, toId: flashTarget }); } setPileCount(1); }
      return flashTarget;
    });
    setQtyModal(null);
    setQtyInput("");
    setLastScanned({ partNumber: scannedPN, invId: flashTarget });
    persistDetailLastScanned(flashTarget, scannedPN);
    if (setLastVisitedId) setLastVisitedId(flashTarget);
    setTimeout(() => flashCard(flashTarget), 1300);
  };

  const getStatus = (inv) => {
    if (inv.complete) return "complete";
    if (inv.parts.some(p => p.confirmed > 0 || p.short)) return "inprogress";
    return "pending";
  };

  // All invoices shown in board — no focus list filtering
  const focused = invoices;

  // Work out cutoff: go back to the last business day (Mon-Fri) before today
  // e.g. Monday → cutoff = last Friday (Sat+Sun+Fri all included)
  // e.g. Tuesday → cutoff = Monday
  const getPendingCutoff = () => {
    const now = new Date();
    // Only today's invoices in PENDING — midnight of today
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  };
  const pendingCutoff = getPendingCutoff();

  const byStage = {
    pending:    focused.filter(inv => !inv.removedFromBoard && getStatus(inv) === "pending" && (inv.manuallyAdded || (inv.invDate || 0) >= pendingCutoff)).sort((a, b) => { const n = s => parseInt(s.id.replace(/\D/g,"")) || 0; return n(b) - n(a); }),
    inprogress: focused.filter(inv => !inv.removedFromBoard && getStatus(inv) === "inprogress").sort((a, b) => { const n = s => parseInt(s.id.replace(/\D/g,"")) || 0; return n(b) - n(a); }),
    complete:   focused.filter(inv => !inv.removedFromBoard && getStatus(inv) === "complete").sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0)),
  };

  const doneCount  = byStage.complete.length;
  const totalCount = focused.length;
  const pct        = totalCount > 0 ? doneCount / totalCount : 0;

  const renderTriageCard = (inv, accent, colKey) => {
    const confirmed  = inv.parts.reduce((s, p) => s + (p.short ? 1 : p.confirmed >= p.qty ? 1 : 0), 0);
    const total      = inv.parts.length;
    const cardPct    = total > 0 ? confirmed / total : 0;
    const hasShort   = inv.parts.some(p => p.short && p.shortQty > 0);
    const hasMissing = inv.parts.some(p => p.short && p.shortQty === 0);
    const isFlashing = flashId === inv.id;
    const lastVisited = lastVisitedId || (lastScanned && lastScanned.invId);
    const isLastVisited = lastVisited === inv.id;
    const isDimmed = dimOtherCards && !!lastVisited && !isLastVisited && !isFlashing;
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const dateTs     = inv.invDate || inv.importedAt || 0;
    const isToday    = dateTs >= todayStart.getTime();
    const isPinned   = pinnedIds.includes(inv.id);
    const isPending  = colKey === "pending";

    const handleLongPress = () => {
      Vibration.vibrate(40);
      // If already in multi-select, toggle this card; otherwise open remove modal
      if (boardMultiSelectIds.length > 0) {
        setBoardMultiSelectIds(prev =>
          prev.includes(inv.id) ? prev.filter(x => x !== inv.id) : [...prev, inv.id]
        );
      } else {
        setRemoveCardModal(inv);
      }
    };

    return (
      <View key={inv.id} onLayout={e => { cardYRefs.current[inv.id] = e.nativeEvent.layout.y; }}>
        <TouchableOpacity
          onPress={() => {
            if (boardMultiSelectIds.length > 0) {
              setBoardMultiSelectIds(prev =>
                prev.includes(inv.id) ? prev.filter(x => x !== inv.id) : [...prev, inv.id]
              );
            } else {
              onSelect(inv.id);
            }
          }}
          onLongPress={handleLongPress} delayLongPress={600} activeOpacity={0.8}
          style={{
            backgroundColor: boardMultiSelectIds.includes(inv.id) ? C.red + "22" : isFlashing ? accent + "22" : C.s2,
            marginBottom: 8,
            borderRadius: isLastVisited ? 12 : 10,
            borderLeftWidth: 4,
            borderLeftColor: boardMultiSelectIds.includes(inv.id) ? C.red : isFlashing ? C.green : accent,
            borderTopWidth: 0, borderRightWidth: 0, borderBottomWidth: 0,
            padding: isLastVisited ? 14 : 12,
            opacity: isDimmed ? 0.35 : 1,
          }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: isFlashing ? C.green : C.t1, fontWeight: "900", fontSize: isLastVisited ? (hideOrderRefs ? 28 : 24) : (hideOrderRefs ? 26 : 22) }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{inv.id}</Text>
              {(!dimOtherCards && isLastVisited && !!lastVisited) && (
                <View style={{ height: 2, backgroundColor: accent, borderRadius: 1, marginTop: 2 }} />
              )}
            </View>
            {boardMultiSelectIds.includes(inv.id)
              ? <View style={{ width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, borderColor: C.red, backgroundColor: C.red, alignItems: "center", justifyContent: "center", marginLeft: 4, flexShrink: 0 }}>
                  <Text style={{ color: "#fff", fontSize: 11, fontWeight: "900" }}>✓</Text>
                </View>
              : boardMultiSelectIds.length > 0
                ? <View style={{ width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, borderColor: C.t3, marginLeft: 4, flexShrink: 0 }} />
                : null
            }
          </View>
          {!hideOrderRefs && <Text style={{ color: C.t2, fontSize: isLastVisited ? 13 : 12, marginTop: 3 }} numberOfLines={1}>{inv.orderRef || "—"}</Text>}
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 6 }}>
            <Text style={{ color: isFlashing ? C.green : accent, fontSize: isLastVisited ? 15 : 13, fontWeight: "700", flex: 1 }}>{confirmed}/{total} parts</Text>
            {isLastVisited && boardMultiSelectIds.length === 0 && <Text style={{ fontSize: 13, color: C.amber, opacity: 0.9, marginLeft: 4, flexShrink: 0 }}>★</Text>}
          </View>
          <View style={{ height: 2, backgroundColor: C.s3, marginTop: 8, overflow: "hidden" }}>
            <View style={{ height: 2, backgroundColor: isFlashing ? C.green : accent, width: `${Math.round(cardPct * 100)}%` }} />
          </View>
          {hasShort && (
            <View style={{ backgroundColor: C.amber + "22", borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, alignSelf: "flex-start", borderWidth: 1, borderColor: C.amber + "55", marginTop: 6 }}>
              <Text style={{ color: C.amber, fontSize: 8, fontWeight: "900" }}>SHORT</Text>
            </View>
          )}
          {hasMissing && (
            <View style={{ backgroundColor: C.red + "22", borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, alignSelf: "flex-start", borderWidth: 1, borderColor: C.red + "55", marginTop: 4 }}>
              <Text style={{ color: C.red, fontSize: 8, fontWeight: "900" }}>MISSING</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      {/* ── Header ── */}
      <View style={{ backgroundColor: C.s2, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: C.b1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 10 }}>
          <TouchableOpacity onPress={onBack} activeOpacity={0.7}
            style={{ backgroundColor: C.s3, borderRadius: 10, padding: 8, borderWidth: 1, borderColor: C.b1 }}>
            <Ionicons name="arrow-back" size={20} color={C.t2} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={{ color: C.t1, fontSize: 20, fontWeight: "900" }}>Focus Board</Text>
          </View>
          {/* Share Board button */}
          <TouchableOpacity onPress={onOpenSession}
            style={{ backgroundColor: currentRoomId ? C.green+"22" : C.s3, borderRadius:10, padding:8, borderWidth:1, borderColor: currentRoomId ? C.green+"55" : C.b1, flexDirection:"row", alignItems:"center", gap:5 }}>
            <MaterialCommunityIcons name={currentRoomId ? "account-group" : "account-plus"} size={18} color={currentRoomId ? C.green : C.t2} />
            {currentRoomId ? <View style={{ width:8, height:8, borderRadius:4, backgroundColor:C.green }} /> : null}
          </TouchableOpacity>
        </View>

        {/* Presence bar — shown when in a room */}
        <PresenceBar
          members={roomMembers}
          userIdentity={userIdentity}
          currentRoomId={currentRoomId}
          roomName={roomName}
          isHost={isRoomHost}
          onKick={(targetId) => wsRef?.current?.send(JSON.stringify({ type:"kick_member", userId:userIdentity?.id, targetId }))}
          onOpenSession={onOpenSession}
        />



        {/* Last scanned — Layout C: split block, pile counter right — always visible */}
        {!bannerHidden && (() => {
          const inv = lastScanned ? invoices.find(i => i.id === lastScanned.invId) : null;
          const status = inv ? (inv.complete ? "complete" : inv.parts.some(p => p.confirmed > 0 || p.short) ? "inprogress" : "pending") : "pending";
          const chipColor = !lastScanned ? C.t3 : status === "complete" ? C.green : status === "inprogress" ? C.amber : C.blue;
          const pileFlashing = !!pileSwitch;
          return (
            <View style={{ marginTop: 10 }}>
              <TouchableOpacity
                onPress={() => { if (lastScanned) { flashCard(lastScanned.invId); if (setLastVisitedId) setLastVisitedId(lastScanned.invId); } }}
                onLongPress={() => { if (lastScanned) onSelect(lastScanned.invId); }}
                delayLongPress={600}
                activeOpacity={lastScanned ? 0.85 : 1}
                style={{ borderRadius: 13, borderWidth: 1, borderColor: C.b1, overflow: "hidden", backgroundColor: C.s2, borderLeftWidth: 5, borderLeftColor: chipColor }}
              >
                {/* Top section: invoice + vertical line + pile */}
                <View style={{ flexDirection: "row", alignItems: "stretch" }}>
                  {/* Left: LAST SCAN + invoice + parts counter */}
                  <View style={{ flex: 1, paddingTop: 12, paddingBottom: 12, paddingLeft: 16 }}>
                    <Text style={{ color: C.t3, fontSize: 10, fontWeight: "900", letterSpacing: 2, marginBottom: 4 }}>LAST SCAN</Text>
                    <Text style={{ color: lastScanned ? C.t1 : C.t3, fontSize: 46, fontWeight: "900", letterSpacing: -2, lineHeight: 48 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>{lastScanned ? lastScanned.invId : ""}</Text>
                    <View style={{ flexDirection: "row", alignItems: "center", marginTop: 6, gap: 8 }}>
                      <Text style={{ color: chipColor, fontSize: 18, fontWeight: "900" }}>{(() => { const confirmed = inv ? inv.parts.filter(p => p.confirmed > 0 || p.short).length : 0; const total = inv ? inv.parts.length : 0; return lastScanned ? `${confirmed}/${total} parts` : "No scans yet"; })()}</Text>
                      {inv?.complete && (
                        <View style={{ backgroundColor: C.green + "22", borderWidth: 1, borderColor: C.green + "66", borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}>
                          <Text style={{ color: C.green, fontSize: 10, fontWeight: "900", letterSpacing: 0.5 }}>✓ COMPLETE</Text>
                        </View>
                      )}
                    </View>
                  </View>
                  {/* Vertical divider — only in top section */}
                  <View style={{ width: 1, backgroundColor: "#2A3A50" }} />
                  {/* Right: pile count centered */}
                  <View style={{ paddingVertical: 12, paddingHorizontal: 16, alignItems: "center", justifyContent: "center", minWidth: 90 }}>
                    <Text style={{ color: pileFlashing ? C.amber : C.t1, fontSize: 46, fontWeight: "900", lineHeight: 48 }}>{pileCount || 0}</Text>
                    <Text style={{ color: C.t3, fontSize: 10, fontWeight: "900", letterSpacing: 1.5, marginTop: 2 }}>IN PILE</Text>
                  </View>
                </View>
                {/* Bottom section: PART + ORDER, no vertical line */}
                <View style={{ borderTopWidth: 1, borderTopColor: C.b1, paddingVertical: 10, paddingHorizontal: 16, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <View>
                    <Text style={{ color: C.t3, fontSize: 10, fontWeight: "900", letterSpacing: 2, marginBottom: 4 }}>PART</Text>
                    <Text style={{ color: lastScanned ? C.t1 : C.t3, fontSize: 18, fontWeight: "900", letterSpacing: 0.5 }} numberOfLines={1}>{lastScanned ? lastScanned.partNumber : ""}</Text>
                  </View>
                  <View>
                    <Text style={{ color: C.t3, fontSize: 10, fontWeight: "900", letterSpacing: 2, marginBottom: 4 }}>ORDER</Text>
                    <Text style={{ color: lastScanned ? C.t1 : C.t3, fontSize: 18, fontWeight: "700", letterSpacing: 0.5 }} numberOfLines={1}>{inv?.orderRef || ""}</Text>
                  </View>
                </View>
              </TouchableOpacity>
              {/* Invisible but finger-friendly X — top-right corner */}
              <TouchableOpacity
                onPress={() => setBannerHidden(true)}
                activeOpacity={0}
                style={{ position: "absolute", top: 0, right: 0, width: 48, height: 48, alignItems: "center", justifyContent: "center" }}
              >
                <Text style={{ color: C.t3 + "33", fontSize: 11, fontWeight: "900" }}>✕</Text>
              </TouchableOpacity>
            </View>
          );
        })()}
        {/* New invoice alert modal */}
        {/* New Invoice Alert — Option B */}
        <Modal visible={!!newInvAlert} transparent animationType="fade">
          <TouchableOpacity style={{ flex: 1, backgroundColor: "#00000088", alignItems: "center", justifyContent: "center", padding: 32 }} activeOpacity={1} onPress={() => { setNewInvAlert(null); if (pendingCompleteRef.current) { const pc = pendingCompleteRef.current; pendingCompleteRef.current = null; setTimeout(() => setCompleteAlert(pc), 300); } }}>
            <View style={{ backgroundColor: C.s1, borderRadius: 24, padding: 28, alignItems: "center", borderWidth: 1.5, borderColor: C.amber + "66", width: "100%" }} onStartShouldSetResponder={() => true}>
              <View style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: C.amber + "22", borderWidth: 1.5, borderColor: C.amber + "66", alignItems: "center", justifyContent: "center", marginBottom: 14 }}>
                <MaterialCommunityIcons name="swap-horizontal" size={28} color={C.amber} />
              </View>
              <Text style={{ color: C.amber, fontSize: 13, fontWeight: "900", letterSpacing: 1.5, marginBottom: 8 }}>NEW INVOICE</Text>
              <Text style={{ color: C.t1, fontSize: 38, fontWeight: "900", letterSpacing: -1.5, marginBottom: 6 }}>{newInvAlert?.toId}</Text>
              <Text style={{ color: C.t3, fontSize: 14, marginBottom: 24 }}>was {newInvAlert?.fromId}</Text>
              <TouchableOpacity onPress={() => { const toId = newInvAlert?.toId; setNewInvAlert(null); if (toId && setLastVisitedId) setLastVisitedId(toId); if (pendingCompleteRef.current) { const pc = pendingCompleteRef.current; pendingCompleteRef.current = null; setTimeout(() => setCompleteAlert(pc), 300); } }} style={{ backgroundColor: C.amber, borderRadius: 14, paddingVertical: 18, width: "100%", alignItems: "center" }}>
                <Text style={{ color: C.bg, fontSize: 17, fontWeight: "900" }}>OK, GOT IT</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Modal>

        {/* Invoice Complete Celebration — Option D */}
        <Modal visible={!!completeAlert} transparent animationType="fade">
          <TouchableOpacity style={{ flex: 1, backgroundColor: "#00000088", alignItems: "center", justifyContent: "center", padding: 32 }} activeOpacity={1} onPress={() => { const id = completeAlert?.invId; setCompleteAlert(null); if (id) { if (setLastVisitedId) setLastVisitedId(id); setTimeout(() => flashCard(id), 100); } }}>
            <View style={{ backgroundColor: C.s1, borderRadius: 24, padding: 28, alignItems: "center", borderWidth: 2, borderColor: C.green + "66", width: "100%" }} onStartShouldSetResponder={() => true}>
              <View style={{ width: 68, height: 68, borderRadius: 34, backgroundColor: C.green + "18", borderWidth: 2, borderColor: C.green + "55", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
                <Ionicons name="checkmark" size={36} color={C.green} />
              </View>
              <Text style={{ color: C.green, fontSize: 13, fontWeight: "900", letterSpacing: 2, marginBottom: 8 }}>COMPLETE</Text>
              <Text style={{ color: C.t1, fontSize: 34, fontWeight: "900", letterSpacing: -1.5, marginBottom: 16 }}>{completeAlert?.invId}</Text>
              <View style={{ flexDirection: "row", gap: 10, marginBottom: 24 }}>
                <View style={{ backgroundColor: C.s2, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 16, alignItems: "center" }}>
                  <Text style={{ color: C.t3, fontSize: 9, fontWeight: "900", letterSpacing: 1 }}>PARTS</Text>
                  <Text style={{ color: C.green, fontSize: 18, fontWeight: "900" }}>{completeAlert?.partCount}</Text>
                </View>
                <View style={{ backgroundColor: C.s2, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 16, alignItems: "center" }}>
                  <Text style={{ color: C.t3, fontSize: 9, fontWeight: "900", letterSpacing: 1 }}>ORDER</Text>
                  <Text style={{ color: C.t1, fontSize: 16, fontWeight: "900" }}>{completeAlert?.orderRef || "—"}</Text>
                </View>
              </View>
              <TouchableOpacity onPress={() => { const id = completeAlert?.invId; setCompleteAlert(null); if (id) { if (setLastVisitedId) setLastVisitedId(id); setTimeout(() => flashCard(id), 100); } }} style={{ backgroundColor: C.green, borderRadius: 14, paddingVertical: 18, width: "100%", alignItems: "center" }}>
                <Text style={{ color: C.bg, fontSize: 17, fontWeight: "900" }}>DONE — NEXT</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Modal>
      </View>

      {/* ── 3-Column Triage Board ── */}
      {focused.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
          <Ionicons name="albums-outline" size={48} color={C.t3} style={{ marginBottom: 12 }} />
          <Text style={{ color: C.t3, fontSize: 16, textAlign: "center" }}>No focus invoices found.</Text>
          <Text style={{ color: C.t3, fontSize: 13, marginTop: 6, textAlign: "center" }}>Check that invoice IDs in your focus list match imported invoices.</Text>
        </View>
      ) : (
        <View style={{ flex: 1, flexDirection: "row" }}>
          {(() => {
            const lastVisited = lastVisitedId || (lastScanned && lastScanned.invId);
            const lastVisitedColKey = lastVisited ? (
              byStage.pending.some(i => i.id === lastVisited) ? "pending" :
              byStage.inprogress.some(i => i.id === lastVisited) ? "inprogress" :
              byStage.complete.some(i => i.id === lastVisited) ? "complete" : null
            ) : null;
            return TRIAGE_COLS.map((col, colIdx) => {
            const items = byStage[col.key];
            const headerDimmed = dimOtherCards && lastVisitedColKey && col.key !== lastVisitedColKey;
            return (
              <View
                key={col.key}
                style={{
                  flex: 1,
                  borderRightWidth: colIdx < TRIAGE_COLS.length - 1 ? 1 : 0,
                  borderRightColor: C.b1,
                }}
              >
                {/* Option B: thin top-border, muted label */}
                <View style={{ borderTopWidth: 3, borderTopColor: headerDimmed ? col.accent + "30" : col.accent, paddingTop: 6, paddingBottom: 6, paddingHorizontal: 6, flexDirection: "row", alignItems: "center", justifyContent: "space-between", opacity: headerDimmed ? 0.4 : 1 }}>
                  <Text style={{ color: C.t3, fontSize: 9, fontWeight: "900", letterSpacing: 1 }}>{col.label}</Text>
                  <Text style={{ color: C.t3, fontSize: 9, fontWeight: "900" }}>{items.length}</Text>
                </View>

                {/* Cards */}
                <ScrollView
                  ref={r => { colScrollRefs.current[col.key] = r; }}
                  style={{ flex: 1 }}
                  contentContainerStyle={{ padding: 8, paddingBottom: 160 }}
                  showsVerticalScrollIndicator={false}
                  refreshControl={col.key === "pending" ? (
                    <RefreshControl refreshing={boardRefreshing} onRefresh={handleBoardRefresh}
                      tintColor={C.green} colors={[C.green]}
                      title={currentRoomId ? "Syncing board..." : ""} titleColor={C.t3} />
                  ) : undefined}
                >
                  {items.map(inv => renderTriageCard(inv, col.accent, col.key))}
                </ScrollView>
              </View>
            );
          });
          })()}
        </View>
      )}

      {/* ── Floating bar — multi-select or scan ── */}
      <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: 16, paddingBottom: Math.max(insets.bottom, 16), backgroundColor: C.bg, borderTopWidth: 1, borderTopColor: C.b1, flexDirection: "row", gap: 10 }}>
        {boardMultiSelectIds.length > 0 ? (
          <>
            <TouchableOpacity
              onPress={() => setBoardMultiSelectIds([])}
              activeOpacity={0.8}
              style={{ backgroundColor: C.s2, borderRadius: 18, paddingVertical: 20, alignItems: "center", justifyContent: "center", paddingHorizontal: 20, borderWidth: 1, borderColor: C.b1 }}>
              <Text style={{ color: C.t2, fontSize: 15, fontWeight: "900" }}>CANCEL</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setKiaInvoices(prev => prev.map(i =>
                  boardMultiSelectIds.includes(i.id) ? { ...i, removedFromBoard: true, manuallyAdded: false } : i
                ));
                setBoardMultiSelectIds([]);
              }}
              activeOpacity={0.85}
              style={{ flex: 1, backgroundColor: C.red + "22", borderRadius: 18, paddingVertical: 20, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 10, borderWidth: 2, borderColor: C.red + "66" }}>
              <MaterialCommunityIcons name="minus-circle-outline" size={26} color={C.red} />
              <Text style={{ color: C.red, fontSize: 18, fontWeight: "900" }}>REMOVE {boardMultiSelectIds.length}</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            {!hideFindBtn && (
            <TouchableOpacity onPress={() => onFindPart && onFindPart(true)} activeOpacity={0.75}
              style={{ width: 64, backgroundColor: C.s2, borderRadius: 18, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: C.b1, paddingVertical: 28 }}>
              <MaterialCommunityIcons name="magnify-scan" size={26} color={C.t3} />
            </TouchableOpacity>
            )}
            <View style={{ flex: 1 }}>
              <View style={{ flex: 1 }}
                onStartShouldSetResponder={() => true}
                onMoveShouldSetResponder={() => true}
                onResponderGrant={(e) => {
                  _scanSwipeY.current = e.nativeEvent.pageY;
                  _scanSwipeX.current = e.nativeEvent.pageX;
                  _scanSwiped.current = false;
                  _scanHeld.current = false;
                  setScanArmed(false);
                  setScanProgress(0);
                  const start = Date.now();
                  _scanProgressInterval.current = setInterval(() => {
                    const pct = Math.min(100, ((Date.now() - start) / 600) * 100);
                    setScanProgress(pct);
                    if (pct >= 100) clearInterval(_scanProgressInterval.current);
                  }, 30);
                  _scanHoldTimer.current = setTimeout(() => {
                    _scanHeld.current = true;
                    setScanArmed(true);
                  }, 600);
                }}
                onResponderMove={(e) => {
                  if (!_scanHeld.current) return;
                  const dx = e.nativeEvent.pageX - _scanSwipeX.current;
                  if (dx > 40 && !_scanSwiped.current) {
                    _scanSwiped.current = true;
                    clearTimeout(_scanHoldTimer.current);
                    clearInterval(_scanProgressInterval.current);
                    setScanArmed(false);
                    setScanProgress(0);
                    onFindPartOcr && onFindPartOcr();
                  } else if (dx < -40 && !_scanSwiped.current) {
                    _scanSwiped.current = true;
                    clearTimeout(_scanHoldTimer.current);
                    clearInterval(_scanProgressInterval.current);
                    setScanArmed(false);
                    setScanProgress(0);
                    onFindPartKeyboard && onFindPartKeyboard();
                  }
                }}
                onResponderRelease={() => {
                  clearTimeout(_scanHoldTimer.current);
                  clearInterval(_scanProgressInterval.current);
                  setScanArmed(false);
                  setScanProgress(0);
                  if (!_scanSwiped.current) setBoardScanMode(true);
                }}>
                {/* Glow rings — visible when armed */}
                <View style={{ position: "absolute", top: -8, left: -8, right: -8, bottom: -8, borderRadius: 26, borderWidth: 4, borderColor: C.green + (scanArmed ? "55" : "00") }} />
                <View style={{ position: "absolute", top: -16, left: -16, right: -16, bottom: -16, borderRadius: 34, borderWidth: 3, borderColor: C.green + (scanArmed ? "22" : "00") }} />
                <TouchableOpacity
                  activeOpacity={0.85}
                  style={{ flex: 1, backgroundColor: C.green, borderRadius: 18, paddingVertical: 28, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 12, elevation: 10 }}>
                  <MaterialCommunityIcons name="barcode-scan" size={40} color={C.bg} />
                </TouchableOpacity>
              </View>
            </View>

          </>
        )}
      </View>


      {/* Remove from board modal */}
      <Modal visible={!!removeCardModal} transparent animationType="fade" onRequestClose={() => setRemoveCardModal(null)}>
        <TouchableOpacity style={{ flex: 1, backgroundColor: "#00000088" }} activeOpacity={1} onPress={() => setRemoveCardModal(null)} />
        <View style={{ backgroundColor: C.s1, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: Math.max(insets.bottom, 24) }}>
          <View style={{ alignSelf: "center", width: 40, height: 4, backgroundColor: C.b1, borderRadius: 2, marginBottom: 16 }} />
          <Text style={{ color: C.t3, fontSize: 10, fontWeight: "900", letterSpacing: 1.5, marginBottom: 4 }}>INVOICE</Text>
          <Text style={{ color: C.t1, fontSize: 22, fontWeight: "900", marginBottom: 2 }}>{removeCardModal?.id}</Text>
          <Text style={{ color: C.t3, fontSize: 13, marginBottom: 20 }}>{removeCardModal?.orderRef || "—"}</Text>
          <TouchableOpacity
            onPress={() => {
              setKiaInvoices(prev => prev.map(i => i.id === removeCardModal.id ? { ...i, removedFromBoard: true, manuallyAdded: false } : i));
              setRemoveCardModal(null);
            }}
            activeOpacity={0.85}
            style={{ backgroundColor: C.red + "22", borderRadius: 14, padding: 18, marginBottom: 10, flexDirection: "row", alignItems: "center", gap: 14, borderWidth: 1.5, borderColor: C.red + "66" }}>
            <MaterialCommunityIcons name="minus-circle-outline" size={24} color={C.red} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: C.red, fontSize: 16, fontWeight: "900" }}>Remove from Focus Board</Text>
              <Text style={{ color: C.t3, fontSize: 12, marginTop: 2 }}>Moves back to the full database</Text>
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              setBoardMultiSelectIds([removeCardModal.id]);
              setRemoveCardModal(null);
            }}
            activeOpacity={0.85}
            style={{ backgroundColor: C.s2, borderRadius: 14, padding: 18, marginBottom: 10, flexDirection: "row", alignItems: "center", gap: 14, borderWidth: 1.5, borderColor: C.b1 }}>
            <MaterialCommunityIcons name="checkbox-multiple-outline" size={24} color={C.t2} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: C.t1, fontSize: 16, fontWeight: "900" }}>Select Multiple</Text>
              <Text style={{ color: C.t3, fontSize: 12, marginTop: 2 }}>Tick more invoices then remove together</Text>
            </View>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setRemoveCardModal(null)} style={{ paddingVertical: 14, alignItems: "center" }}>
            <Text style={{ color: C.t3, fontSize: 16 }}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </Modal>

      <BarcodeScanner
        visible={boardScanMode}
        title="Scan Part Number Barcode"
        torchEnabled={torchEnabled}
        onClose={() => setBoardScanMode(false)}
        onScanned={autoConfirmPart}
        partsDB={invoices.flatMap(inv => inv.parts.map(p => ({ partNumber: p.partNumber })))}
      />

      {/* Multi-invoice picker modal */}
      <Modal visible={!!multiMatch} transparent animationType="slide" onRequestClose={() => setMultiMatch(null)}>
        <TouchableOpacity style={{ flex: 1, backgroundColor: "#00000088" }} activeOpacity={1} onPress={() => setMultiMatch(null)} />
        <View style={{ backgroundColor: C.s1, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: Math.max(insets.bottom, 24) }}>
          <View style={{ alignSelf: "center", width: 40, height: 4, backgroundColor: C.b1, borderRadius: 2, marginBottom: 16 }} />
          <Text style={{ color: C.t3, fontSize: 10, fontWeight: "900", letterSpacing: 1.5, marginBottom: 4 }}>
            {multiMatch?.outsideBoard ? "NOT IN FOCUS BOARD" : "MULTIPLE INVOICES"}
          </Text>
          <Text style={{ color: C.t1, fontSize: 18, fontWeight: "900", marginBottom: 4 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.4}>{multiMatch?.partNumber}</Text>
          <Text style={{ color: C.t3, fontSize: 12, marginBottom: 16 }}>
            {multiMatch?.outsideBoard ? "Found outside focus board — tap to confirm anyway" : "Which invoice is this part for?"}
          </Text>
          <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator={false}>
            {multiMatch?.matches?.map(({ inv, idx, allIdx }) => {
              const part = inv.parts[idx];
              const status = getStatus(inv);
              const accent = status === "complete" ? C.green : status === "inprogress" ? C.amber : C.red;
              const confirmed = inv.parts.reduce((s, p) => s + (p.short ? 1 : p.confirmed >= p.qty ? 1 : 0), 0);
              const total = inv.parts.length;
              const hasMultiLines = allIdx && allIdx.length > 1;
              const totalPendingQty = allIdx ? allIdx.reduce((s, i) => s + inv.parts[i].qty, 0) : part.qty;
              return (
                <View key={inv.id + "-" + idx} style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
                  {/* Left — main card, tap = confirm this line only */}
                  <TouchableOpacity
                    onPress={() => { setMultiMatch(null); confirmMatch(inv, idx, multiMatch.scanned); }}
                    activeOpacity={0.8}
                    style={{ flex: 1, backgroundColor: C.s2, borderRadius: 12, padding: 14, borderLeftWidth: 4, borderLeftColor: accent, borderTopWidth: 0, borderRightWidth: 0, borderBottomWidth: 0 }}>
                    <View style={{ flexDirection: "row", alignItems: "center" }}>
                      <Text style={{ color: C.t1, fontSize: 16, fontWeight: "900", flex: 1 }}>{inv.id}</Text>
                      <View style={{ backgroundColor: accent + "22", borderRadius: 20, paddingHorizontal: 8, paddingVertical: 3 }}>
                        <Text style={{ color: accent, fontSize: 9, fontWeight: "900" }}>{status === "complete" ? "DONE" : status === "inprogress" ? "IN PROG" : "PENDING"}</Text>
                      </View>
                    </View>
                    <Text style={{ color: C.t3, fontSize: 12, marginTop: 3 }}>{inv.orderRef || "—"} · {confirmed}/{total} parts</Text>
                    <Text style={{ color: accent, fontSize: 11, fontWeight: "700", marginTop: 4 }}>
                      {hasMultiLines ? `${allIdx.length} lines · ${totalPendingQty} units pending` : `Line ${part.lineNo || (idx + 1)} — qty ${part.qty}`}
                    </Text>
                    {hasMultiLines && (
                      <View style={{ marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.b1 }}>
                        <Text style={{ color: C.t3, fontSize: 10 }}>tap here → confirm 1 unit only</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                  {/* Right — confirm all block, only shown when multiple lines */}
                  {hasMultiLines && (
                    <TouchableOpacity
                      onPress={() => confirmAllLines(inv, allIdx, multiMatch.scanned)}
                      activeOpacity={0.8}
                      style={{ backgroundColor: C.s2, borderRadius: 12, borderWidth: 2, borderColor: C.green, minWidth: 82, alignItems: "center", justifyContent: "center", gap: 4, paddingVertical: 14, paddingHorizontal: 12 }}>
                      <Text style={{ color: C.green, fontSize: 28, fontWeight: "900", lineHeight: 30 }}>{totalPendingQty}</Text>
                      <Text style={{ color: C.green + "99", fontSize: 9, fontWeight: "900", textAlign: "center", letterSpacing: 0.5 }}>CONFIRM</Text>
                      <Text style={{ color: C.green + "99", fontSize: 9, fontWeight: "900", textAlign: "center", letterSpacing: 0.5 }}>ALL</Text>
                      <Text style={{ color: C.green + "66", fontSize: 8, textAlign: "center", marginTop: 2 }}>{allIdx.length} lines</Text>
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}
          </ScrollView>
          <TouchableOpacity onPress={() => setMultiMatch(null)} style={{ paddingVertical: 14, alignItems: "center", marginTop: 4 }}>
            <Text style={{ color: C.t3, fontSize: 16 }}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </Modal>

            {/* Qty modal for multi-qty parts */}
      <Modal visible={!!qtyModal} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: "#000000AA", justifyContent: "flex-end" }}>
          <View style={{ backgroundColor: C.s1, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 28, paddingBottom: 48 }}>
            <Text style={{ color: C.t3, fontSize: 11, fontWeight: "900", letterSpacing: 1.5, marginBottom: 4 }}>AUTO CONFIRM — MULTI QTY</Text>
            <Text style={{ color: C.t1, fontSize: 20, fontWeight: "900", marginBottom: 4 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.4}>{qtyModal?.partNumber}</Text>
            <Text style={{ color: C.t3, fontSize: 14, marginBottom: 20 }}>Expected qty: {qtyModal?.expected}</Text>
            <View style={{ backgroundColor: C.s2, borderRadius: 16, borderWidth: 2, borderColor: C.green + "66", padding: 20, alignItems: "center", marginBottom: 16 }}>
              <Text style={{ color: C.t3, fontSize: 13, fontWeight: "700", marginBottom: 4 }}>CONFIRMING QTY</Text>
              <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 4 }}>
                <Text style={{ color: C.green, fontSize: 52, fontWeight: "900", letterSpacing: 2 }}>{qtyInput || "0"}</Text>
                <Text style={{ color: C.t3, fontSize: 32, fontWeight: "700", marginBottom: 6 }}>/{qtyModal?.expected}</Text>
              </View>
            </View>
            {[["1","2","3"],["4","5","6"],["7","8","9"],["⌫","0","✓"]].map((row, ri) => (
              <View key={ri} style={{ flexDirection: "row", gap: 10, marginBottom: 10 }}>
                {row.map(key => {
                  const isConfirm = key === "✓"; const isBack = key === "⌫";
                  return (
                    <TouchableOpacity key={key} activeOpacity={0.7}
                      onPress={() => {
                        if (isConfirm) { applyQtyConfirm(); }
                        else if (isBack) { setQtyInput(q => q.slice(0, -1)); }
                        else { setQtyInput(q => q.length >= 3 ? q : q + key); }
                      }}
                      style={{ flex: 1, paddingVertical: 20, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: isConfirm ? C.green : isBack ? C.s3 : C.s2, borderWidth: 1.5, borderColor: isConfirm ? C.green : C.b1 }}
                    >
                      <Text style={{ color: isConfirm ? C.bg : C.t1, fontSize: 24, fontWeight: "800" }}>{key}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ))}
            <TouchableOpacity onPress={() => { setQtyModal(null); setQtyInput(""); }} style={{ paddingVertical: 14, paddingHorizontal: 40, alignItems: "center", alignSelf: "center", minWidth: 120 }}>
              <Text style={{ color: C.t3, fontSize: 16, letterSpacing: 0.5 }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Scan result popup overlay */}
      {scanPopup ? (
        <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", backgroundColor: "#00000055" }}>
          <View style={{ width: 220, backgroundColor: scanPopup.color, borderRadius: 28, paddingVertical: 32, paddingHorizontal: 24, alignItems: "center" }}>
            <Text style={{ color: scanPopup.color === C.red ? "#fff" : "#07090F", fontSize: 72, fontWeight: "900", lineHeight: 76, marginBottom: 8 }}>{scanPopup.icon}</Text>
            <Text style={{ color: "#fff", fontSize: 20, fontWeight: "900", letterSpacing: 1, marginTop: 4, textAlign: "center", paddingHorizontal: 20 }}>{scanPopup.label}</Text>
            {scanPopup.invId ? <Text style={{ color: "#ffffff88", fontSize: 13, fontWeight: "700", marginTop: 4 }}>{scanPopup.invId}</Text> : null}
          </View>
        </View>
      ) : null}

      {/* ── Incoming join request popup (host only) ── */}
      {incomingJoinReq && isRoomHost && (
        <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", backgroundColor: "#00000077" }}>
          <View style={{ backgroundColor: C.s1, borderRadius: 24, padding: 24, marginHorizontal: 24, width: "90%", borderWidth: 1, borderColor: incomingJoinReq.requesterColor + "66" }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginBottom: 18 }}>
              <View style={{ width: 52, height: 52, borderRadius: 26,
                backgroundColor: incomingJoinReq.requesterColor + "22",
                borderWidth: 2, borderColor: incomingJoinReq.requesterColor,
                alignItems: "center", justifyContent: "center" }}>
                <Text style={{ color: incomingJoinReq.requesterColor, fontSize: 18, fontWeight: "900" }}>
                  {incomingJoinReq.requesterInitials}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: C.t1, fontSize: 16, fontWeight: "900" }}>
                  {incomingJoinReq.requesterName || incomingJoinReq.requesterInitials} wants to join
                </Text>
                <Text style={{ color: C.t3, fontSize: 13, marginTop: 2 }}>
                  Requesting access to your board
                </Text>
              </View>
            </View>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <TouchableOpacity
                onPress={() => onRespondJoinReq(true)}
                activeOpacity={0.8}
                style={{ flex: 1, backgroundColor: C.green + "22", borderRadius: 14, paddingVertical: 16, alignItems: "center", borderWidth: 1, borderColor: C.green + "55" }}>
                <Text style={{ color: C.green, fontSize: 15, fontWeight: "900" }}>ALLOW</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => onRespondJoinReq(false)}
                activeOpacity={0.8}
                style={{ flex: 1, backgroundColor: C.red + "22", borderRadius: 14, paddingVertical: 16, alignItems: "center", borderWidth: 1, borderColor: C.red + "55" }}>
                <Text style={{ color: C.red, fontSize: 15, fontWeight: "900" }}>DECLINE</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

// ─── KIA FIND PART SCREEN ─────────────────────────────────────────────────────
function KiaFindPartScreen({ invoices, onBack, setKiaInvoices, torchEnabled, initialQuery, autoScan, onAutoScanDone, onGoToDetail, initialOcrMode, initialKeyboardMode }) {
  const insets = useSafeAreaInsets();
  const [scannerVisible, setScannerVisible] = useState(false);
  const [scannerInitKeyboard, setScannerInitKeyboard] = useState(false);
  const [scannerInitOcr, setScannerInitOcr] = useState(false);
  // Open OCR directly if requested
  useEffect(() => { if (initialOcrMode) { setScannerInitOcr(true); setScannerVisible(true); } }, []);
  // Open keyboard directly if requested
  useEffect(() => { if (initialKeyboardMode) { setScannerInitKeyboard(true); setScannerVisible(true); } }, []);
  const [query, setQuery]                   = useState(initialQuery || "");
  const [matches, setMatches]               = useState(null); // null | [] | [{inv, part}]
  const [searchedPart, setSearchedPart]     = useState("");

  const allParts = [];
  invoices.forEach(inv => inv.parts.forEach(p => allParts.push({ partNumber: p.partNumber })));

  const getStatus = (inv) => {
    if (inv.complete) return "complete";
    if (inv.parts.some(p => p.confirmed > 0 || p.short)) return "inprogress";
    return "pending";
  };

  const search = (raw) => {
    const q = String(raw).trim().toUpperCase();
    if (!q) { setMatches(null); setSearchedPart(""); return; }
    setSearchedPart(q);
    const found = [];
    for (const inv of invoices) {
      // Check order number match first
      const orderRef = (inv.orderRef || "").toUpperCase().replace(/-/g, "");
      const qs = q.replace(/-/g, "");
      if (orderRef && (orderRef === qs || orderRef.includes(qs) || qs.includes(orderRef))) {
        // Order number match — use first part as representative
        const part = inv.parts[0];
        if (part) found.push({ inv, part });
        continue;
      }
      // Check part number match
      const part = inv.parts.find(p => {
        const pn = p.partNumber.toUpperCase().replace(/-/g, "");
        return p.partNumber.toUpperCase() === q || pn === qs || pn.includes(qs) || qs.includes(pn);
      });
      if (part) found.push({ inv, part });
    }
    // Sort newest first by invDate, then importedAt
    found.sort((a, b) => (b.inv.invDate || b.inv.importedAt || 0) - (a.inv.invDate || a.inv.importedAt || 0));
    setMatches(found);
  };

  const addToBoard = (invId) => {
    setKiaInvoices(prev => prev.map(i =>
      i.id === invId ? { ...i, manuallyAdded: true, removedFromBoard: false } : i
    ));
  };

  const addAllPendingToBoard = () => {
    if (!matches) return;
    const ids = matches
      .filter(m => !m.inv.complete && !m.inv.removedFromBoard)
      .map(m => m.inv.id);
    setKiaInvoices(prev => prev.map(i =>
      ids.includes(i.id) ? { ...i, manuallyAdded: true, removedFromBoard: false } : i
    ));
  };

  const isOnBoard = (inv) => !inv.removedFromBoard && (inv.manuallyAdded || inv.complete || inv.parts.some(p => p.confirmed > 0));

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      {/* Header */}
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 16, paddingBottom: 12, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: 1, borderBottomColor: C.b1, backgroundColor: C.s2 }}>
        <TouchableOpacity onPress={onBack} activeOpacity={0.7}
          style={{ backgroundColor: C.s3, borderRadius: 10, padding: 8, borderWidth: 1, borderColor: C.b1 }}>
          <Ionicons name="arrow-back" size={20} color={C.t2} />
        </TouchableOpacity>
        <Text style={{ color: C.t1, fontSize: 20, fontWeight: "900", flex: 1 }}>Find Invoice</Text>
        {matches !== null && (
          <View style={{ backgroundColor: matches.length > 0 ? C.green + "22" : C.red + "22", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: matches.length > 0 ? C.green + "55" : C.red + "55" }}>
            <Text style={{ color: matches.length > 0 ? C.green : C.red, fontSize: 12, fontWeight: "900" }}>
              {matches.length > 0 ? `${matches.length} invoice${matches.length !== 1 ? "s" : ""}` : "Not found"}
            </Text>
          </View>
        )}
      </View>



      {/* Part name strip */}
      {matches !== null && matches.length > 0 && (
        <View style={{ paddingHorizontal: 16, paddingVertical: 10, backgroundColor: C.s2, borderBottomWidth: 1, borderBottomColor: C.b1 }}>
          <Text style={{ color: C.t3, fontSize: 11, fontWeight: "900", letterSpacing: 1, marginBottom: 2 }}>PART</Text>
          <Text style={{ color: C.t1, fontSize: 21, fontWeight: "900" }}>{matches[0].part.partNumber}</Text>
          {matches[0].part.description ? <Text style={{ color: C.t3, fontSize: 14, marginTop: 2 }}>{matches[0].part.description}</Text> : null}
        </View>
      )}

      {/* Invoice list */}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 120 }}>
        {matches === null && (
          <View style={{ alignItems: "center", justifyContent: "center", flex: 1, paddingVertical: 40 }}>
            <MaterialCommunityIcons name="magnify-scan" size={72} color={C.t3} style={{ marginBottom: 16 }} />
            <Text style={{ color: C.t1, fontSize: 22, fontWeight: "900", textAlign: "center", marginBottom: 6 }}>How to find invoices</Text>
            <Text style={{ color: C.t3, fontSize: 14, textAlign: "center", marginBottom: 24 }}>Use any of the methods below</Text>
            {/* 1: Scan */}
            <View style={{ width: "100%", flexDirection: "row", alignItems: "flex-start", gap: 14, backgroundColor: C.blue + "18", borderRadius: 14, padding: 18, marginBottom: 10, borderWidth: 1, borderColor: C.blue + "33" }}>
              <Text style={{ color: C.blue, fontSize: 22, fontWeight: "900", width: 28, textAlign: "center" }}>1</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: C.blue, fontSize: 16, fontWeight: "900" }}>Scan a barcode</Text>
                <Text style={{ color: C.t3, fontSize: 13, marginTop: 4 }}>Point the camera at the barcode on the part</Text>
              </View>
            </View>
            {/* 2: OCR */}
            <View style={{ width: "100%", flexDirection: "row", alignItems: "flex-start", gap: 14, backgroundColor: C.s2, borderRadius: 14, padding: 18, marginBottom: 10, borderWidth: 1, borderColor: C.b1 }}>
              <Text style={{ color: C.t3, fontSize: 22, fontWeight: "900", width: 28, textAlign: "center" }}>2</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: C.t1, fontSize: 16, fontWeight: "900" }}>OCR — take a photo</Text>
                <Text style={{ color: C.t3, fontSize: 13, marginTop: 4 }}>Photograph the part number text to search</Text>
              </View>
            </View>
            {/* 3: Keyboard */}
            <View style={{ width: "100%", flexDirection: "row", alignItems: "flex-start", gap: 14, backgroundColor: C.s2, borderRadius: 14, padding: 18, borderWidth: 1, borderColor: C.b1 }}>
              <Text style={{ color: C.t3, fontSize: 22, fontWeight: "900", width: 28, textAlign: "center" }}>3</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: C.t1, fontSize: 16, fontWeight: "900" }}>Keyboard — type it in</Text>
                <Text style={{ color: C.t3, fontSize: 13, marginTop: 4 }}>Enter a part number or order number</Text>
              </View>
            </View>
          </View>
        )}
        {matches !== null && matches.length === 0 && (
          <View style={{ alignItems: "center", paddingTop: 60 }}>
            <Ionicons name="search-outline" size={52} color={C.red} style={{ marginBottom: 12 }} />
            <Text style={{ color: C.red, fontWeight: "900", fontSize: 16, marginBottom: 6 }}>Part Not Found</Text>
            <Text style={{ color: C.t3, fontSize: 14, textAlign: "center" }}>"{searchedPart}" not on any invoice</Text>
          </View>
        )}
        {matches !== null && matches.length > 0 && (
          <>
            <Text style={{ color: C.t3, fontSize: 9, fontWeight: "900", letterSpacing: 1, marginBottom: 10 }}>
              {matches.length} INVOICE{matches.length !== 1 ? "S" : ""} — NEWEST FIRST
            </Text>
            {matches.map(({ inv, part }) => {
              const status = getStatus(inv);
              const accent = status === "complete" ? C.green : status === "inprogress" ? C.amber : C.red;
              const statusLabel = status === "complete" ? "DONE" : status === "inprogress" ? "IN PROG" : "PENDING";
              const onBoard = isOnBoard(inv);
              return (
                <TouchableOpacity key={inv.id} onPress={() => { if (!onBoard) addToBoard(inv.id); onGoToDetail && onGoToDetail(inv.id, searchedPart); }} activeOpacity={0.85} style={{ backgroundColor: C.s2, borderRadius: 12, padding: 14, marginBottom: 8, borderLeftWidth: 4, borderLeftColor: accent, borderTopWidth: 0, borderRightWidth: 0, borderBottomWidth: 0 }}>
                  <View style={{ flexDirection: "row", alignItems: "center" }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: C.t1, fontSize: 24, fontWeight: "900" }}>{inv.id}</Text>
                      <Text style={{ color: C.t3, fontSize: 17, fontWeight: "700", marginTop: 3 }}>{inv.orderRef || "—"}</Text>
                    </View>
                    <View style={{ alignItems: "flex-end", gap: 6 }}>
                      <View style={{ backgroundColor: accent + "22", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: accent + "55" }}>
                        <Text style={{ color: accent, fontSize: 10, fontWeight: "900" }}>{statusLabel}</Text>
                      </View>
                      {onBoard ? (
                        <View style={{ backgroundColor: C.blue + "22", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: C.blue + "55" }}>
                          <Text style={{ color: C.blue, fontSize: 10, fontWeight: "900" }}>ON FOCUS BOARD</Text>
                        </View>
                      ) : (
                        <View onStartShouldSetResponder={() => true} onTouchEnd={(e) => e.stopPropagation()}>
                          <TouchableOpacity onPress={() => { addToBoard(inv.id); onGoToDetail && onGoToDetail(inv.id, searchedPart); }} activeOpacity={0.8}
                            style={{ backgroundColor: C.green + "22", borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12, borderWidth: 1, borderColor: C.green + "55", minWidth: 80, alignItems: "center" }}>
                            <Text style={{ color: C.green, fontSize: 14, fontWeight: "900" }}>+ ADD</Text>
                          </TouchableOpacity>
                        </View>
                      )}
                    </View>
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", marginTop: 8 }}>
                    <Text style={{ color: accent, fontSize: 16, fontWeight: "900" }}>
                      {part.confirmed}/{part.qty} confirmed
                    </Text>
                    {inv.invDate ? <Text style={{ color: C.t3, fontSize: 15, fontWeight: "700", marginLeft: 8 }}>{(() => { const d = new Date(inv.invDate); return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`; })()}</Text> : null}
                  </View>
                </TouchableOpacity>
              );
            })}
          </>
        )}
      </ScrollView>

      {/* Bottom — always visible SCAN button bar */}
      <View style={{ paddingHorizontal: 14, paddingBottom: Math.max(insets.bottom, 16), paddingTop: 12, borderTopWidth: 1, borderTopColor: C.b1, backgroundColor: C.bg, flexDirection: "row", gap: 10, alignItems: "center" }}>
        {/* Keyboard button — same size as Focus Board side buttons */}
        <TouchableOpacity onPress={() => { setScannerInitKeyboard(true); setScannerInitOcr(false); setScannerVisible(true); }} activeOpacity={0.8}
          style={{ width: 64, backgroundColor: C.s2, borderRadius: 18, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: C.b1, paddingVertical: 28, alignSelf: "stretch" }}>
          <MaterialCommunityIcons name="keyboard-outline" size={26} color={C.t3} />
        </TouchableOpacity>
        {/* SCAN button — same size as Focus Board SCAN */}
        <TouchableOpacity onPress={() => { setMatches(null); setSearchedPart(""); setScannerInitKeyboard(false); setScannerInitOcr(false); setScannerVisible(true); }} activeOpacity={0.85}
          style={{ flex: 1, backgroundColor: C.blue, borderRadius: 18, paddingVertical: 28, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 12 }}>
          <MaterialCommunityIcons name="barcode-scan" size={40} color={C.bg} />
        </TouchableOpacity>
        {/* OCR button — same size as Focus Board side buttons */}
        <TouchableOpacity onPress={() => { setScannerInitOcr(true); setScannerInitKeyboard(false); setScannerVisible(true); }} activeOpacity={0.8}
          style={{ width: 64, backgroundColor: C.s2, borderRadius: 18, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: C.b1, paddingVertical: 28, alignSelf: "stretch" }}>
          <Text style={{ color: C.t3, fontSize: 13, fontWeight: "900" }}>OCR</Text>
        </TouchableOpacity>
      </View>

      <BarcodeScanner visible={scannerVisible} title="Invoice Data Base Look Up" onScanned={(s) => { setScannerVisible(false); setScannerInitKeyboard(false); setScannerInitOcr(false); setQuery(s); search(s); }} onClose={() => { setScannerVisible(false); setScannerInitKeyboard(false); setScannerInitOcr(false); onBack(); }} partsDB={allParts} torchEnabled={torchEnabled} initialKeyboard={scannerInitKeyboard} initialOcr={scannerInitOcr} />
    </View>
  );
}


// ─── ROOT APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [kiaInvoices, setKiaInvoices]         = useState([]);
  const [kiaScreen, setKiaScreen]             = useState("home");
  const [activeKiaId, setActiveKiaId]         = useState(null);
  const [kiaReturnScreen, setKiaReturnScreen] = useState("board");
  const [kiaLastScanned, setKiaLastScanned]   = useState(null);
  const [kiaFocusList, setKiaFocusList]       = useState([]);
  const [kiaPinnedIds, setKiaPinnedIds]       = useState([]);
  const [kiaActiveInvId, setKiaActiveInvId]   = useState(null);
  const [kiaPileCount, setKiaPileCount]       = useState(0);
  const [kiaHideOrderRefs, setKiaHideOrderRefs] = useState(true);
  const [kiaSuppressNewInv, setKiaSuppressNewInv] = useState(false);
  const [kiaDimOtherCards, setKiaDimOtherCards] = useState(true);
  const [kiaHideFindBtn, setKiaHideFindBtn]     = useState(true);
  const [hideBackorderCol, setHideBackorderCol] = useState(true);
  const [kiaLastVisitedId, setKiaLastVisitedId] = useState(null);
  const [kiaPrecountCamera, setKiaPrecountCamera] = useState(false);
  const [kiaFindCamera, setKiaFindCamera]     = useState(false);
  const [kiaPartLookupCamera, setKiaPartLookupCamera] = useState(false);
  const [kiaFindQuery, setKiaFindQuery]       = useState("");
  const [kiaFindAutoScan, setKiaFindAutoScan]   = useState(false);
  const [kiaFindInitOcr, setKiaFindInitOcr]     = useState(false);
  const [kiaFindInitKeyboard, setKiaFindInitKeyboard] = useState(false);
  const [kiaFindPartNumber, setKiaFindPartNumber] = useState(null);
  const [kiaPartResult, setKiaPartResult]     = useState(null);
  const [kiaHideClosedInvoices, setKiaHideClosedInvoices] = useState(true);
  const [kiaPartLookupResult, setKiaPartLookupResult] = useState(null);
  const kiaPartLookupRawRef = useRef(null);
  const [invoiceLookupVisible, setInvoiceLookupVisible] = useState(false);
  const [invoiceLookupText, setInvoiceLookupText]       = useState("");
  const invoiceLookupInputRef = useRef(null);
  const [dispatchInvoices, setDispatchInvoices]   = useState([]);
  const [activeDispatchId, setActiveDispatchId]   = useState(null);
  const [showDispatchPrecount, setShowDispatchPrecount] = useState(false);
  const [torchEnabled, setTorchEnabled]       = useState(true);
  const [importResult, setImportResult]       = useState(null);
  const [importing, setImporting]             = useState(false);
  const [serverPickerVisible, setServerPickerVisible] = useState(false);
  const [serverFiles, setServerFiles]         = useState([]);
  const [fileMeta, setFileMeta]               = useState({}); // { filename: { serverTime, appTime } }
  const [syncPopover, setSyncPopover]         = useState(null); // filename string
  const [serverFetching, setServerFetching]   = useState(false);
  const [wsStatus, setWsStatus]               = useState(null); // null | "updated" | "pending" | "missing" | "offline"
  const [exportFilterVisible, setExportFilterVisible] = useState(false);
  const [wsLastSync, setWsLastSync]           = useState(null); // timestamp ms
  const wsRef                                 = useRef(null);
  const wsReconnectRef                        = useRef(null);
  const wsRetryDelayRef                       = useRef(5000); // exponential backoff delay
  const [activeBoards, setActiveBoards]       = useState([]); // rooms available to join
  const [incomingJoinReq, setIncomingJoinReq] = useState(null); // { requesterId, requesterInitials, requesterColor, requesterName, roomId }
  const [pendingLocalImport, setPendingLocalImport] = useState(false);

  // ── Board sync state ─────────────────────────────────────────────────────
  const [userIdentity, setUserIdentity]       = useState(null);
  const [showIdentitySetup, setShowIdentitySetup] = useState(false);
  const [showSessionModal, setShowSessionModal]   = useState(false);
  const [currentRoomId, setCurrentRoomId]     = useState(null);
  const [roomName, setRoomName]               = useState(null);
  const [roomMembers, setRoomMembers]         = useState([]);
  const [isRoomHost, setIsRoomHost]           = useState(false);
  const focusListSyncRef                      = useRef(null);
  const invoiceSyncRef                        = useRef(null);
  const userIdentityRef                       = useRef(null);
  const currentRoomIdRef                      = useRef(null);

  // Keep refs in sync with state (WS callbacks can't read state directly)
  useEffect(() => { userIdentityRef.current = userIdentity; }, [userIdentity]);
  useEffect(() => { currentRoomIdRef.current = currentRoomId; }, [currentRoomId]);

  // Helper: apply a batch of server invoiceUpdates into local invoice array
  function applyInvoiceUpdates(invoices, updates) {
    return invoices.map(inv => {
      const upd = updates[inv.id];
      if (!upd) return inv;
      return {
        ...inv,
        complete: upd.complete || inv.complete,
        completedAt: upd.completedAt || inv.completedAt,
        completedBy: upd.completedBy || inv.completedBy,
        parts: inv.parts.map(p => {
          const key = p.partNumber + "_" + (p.lineNo || "0");
          const pu = upd.parts?.[key];
          if (!pu) return p;
          return { ...p, confirmed: pu.confirmed, short: pu.short, shortQty: pu.shortQty,
            confirmedBy: pu.confirmedBy, confirmedColor: pu.confirmedColor, confirmedAt: pu.confirmedAt };
        }),
      };
    });
  }

  // ── Persistence ──────────────────────────────────────────────────────────
  useEffect(() => {
    AsyncStorage.getItem(KIA_STORAGE_KEY).then(raw => {
      if (raw) { try { setKiaInvoices(JSON.parse(raw)); } catch {} }
    });
    AsyncStorage.getItem("@kia_focuslist_v1").then(raw => {
      if (raw) { try { setKiaFocusList(JSON.parse(raw)); } catch {} }
    });
    AsyncStorage.getItem("@kia_pinnedids_v1").then(raw => {
      if (raw) { try { setKiaPinnedIds(JSON.parse(raw)); } catch {} }
    });
    AsyncStorage.getItem("@kia_lastscanned_v1").then(raw => {
      if (raw) { try { setKiaLastScanned(JSON.parse(raw)); } catch {} }
    });
    AsyncStorage.getItem("@dispatch_invoices_v1").then(raw => {
      if (raw) { try { setDispatchInvoices(JSON.parse(raw)); } catch {} }
    });
    // Load user identity — show setup modal if first time
    AsyncStorage.getItem(USER_IDENTITY_KEY).then(raw => {
      if (raw) { try { setUserIdentity(JSON.parse(raw)); } catch { setShowIdentitySetup(true); } }
      else { setShowIdentitySetup(true); }
    });
    // Restore session if same day
    AsyncStorage.getItem(BOARD_SESSION_KEY).then(raw => {
      if (!raw) return;
      try {
        const s = JSON.parse(raw);
        const midnight = new Date(); midnight.setHours(0,0,0,0);
        if (s.savedAt >= midnight.getTime()) {
          setCurrentRoomId(s.roomId);
          setRoomName(s.roomName);
        }
      } catch {}
    });
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(KIA_STORAGE_KEY, JSON.stringify(kiaInvoices)).catch(() => {});
  }, [kiaInvoices]);

  // ── Auto-push full invoice state to server when in a room (debounced 2s) ──
  // This keeps room.invoices fresh so late joiners always get the full picture
  // Gated on currentRoomId so it only runs when actually in a room
  useEffect(() => {
    if (!currentRoomId || !currentRoomIdRef.current || !userIdentityRef.current) return;
    if (!wsRef.current || wsRef.current.readyState !== 1) return;
    clearTimeout(invoiceSyncRef.current);
    invoiceSyncRef.current = setTimeout(() => {
      if (!currentRoomIdRef.current || !wsRef.current || wsRef.current.readyState !== 1) return;
      wsRef.current.send(JSON.stringify({
        type: "sync_invoices",
        invoices: kiaInvoices,
        userId: userIdentityRef.current.id,
      }));
    }, 2000);
  }, [kiaInvoices, currentRoomId]);

  useEffect(() => {
    if (userIdentity) AsyncStorage.setItem(USER_IDENTITY_KEY, JSON.stringify(userIdentity)).catch(() => {});
  }, [userIdentity]);

  // ── Startup race fix: if WS connected before AsyncStorage loaded session/identity,
  // rejoin the room as soon as both currentRoomId and userIdentity are available ──
  const hasRejoinedRef = useRef(false);
  useEffect(() => {
    if (!currentRoomId || !userIdentity) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return; // WS not open yet — onopen will handle it
    if (hasRejoinedRef.current) return; // Already rejoined this session
    hasRejoinedRef.current = true;
    ws.send(JSON.stringify({ type: "identify", ...userIdentity }));
    ws.send(JSON.stringify({
      type: "join_room", roomId: currentRoomId,
      userId: userIdentity.id, initials: userIdentity.initials,
      color: userIdentity.color, name: userIdentity.name, mergeMode: "merge",
    }));
  }, [currentRoomId, userIdentity]);

  useEffect(() => {
    if (currentRoomId) {
      AsyncStorage.setItem(BOARD_SESSION_KEY, JSON.stringify({ roomId: currentRoomId, roomName, savedAt: Date.now() })).catch(() => {});
    } else {
      AsyncStorage.removeItem(BOARD_SESSION_KEY).catch(() => {});
    }
  }, [currentRoomId, roomName]);

  useEffect(() => {
    AsyncStorage.setItem("@kia_focuslist_v1", JSON.stringify(kiaFocusList)).catch(() => {});
    // Only broadcast to room if actually in one
    if (!currentRoomId || !currentRoomIdRef.current || !userIdentityRef.current) return;
    if (!wsRef.current || wsRef.current.readyState !== 1) return;
    clearTimeout(focusListSyncRef.current);
    focusListSyncRef.current = setTimeout(() => {
      if (!wsRef.current || wsRef.current.readyState !== 1) return;
      wsRef.current.send(JSON.stringify({
        type: "focuslist_update",
        focusList: kiaFocusList,
        pinnedIds: kiaPinnedIds,
        initials: userIdentityRef.current?.initials,
        userId: userIdentityRef.current?.id,
      }));
    }, 500);
  }, [kiaFocusList, currentRoomId]);

  useEffect(() => {
    AsyncStorage.setItem("@kia_pinnedids_v1", JSON.stringify(kiaPinnedIds)).catch(() => {});
  }, [kiaPinnedIds]);

  useEffect(() => {
    if (kiaLastScanned) {
      AsyncStorage.setItem("@kia_lastscanned_v1", JSON.stringify(kiaLastScanned)).catch(() => {});
    }
  }, [kiaLastScanned]);

  useEffect(() => {
    AsyncStorage.setItem("@dispatch_invoices_v1", JSON.stringify(dispatchInvoices)).catch(() => {});
  }, [dispatchInvoices]);

  // ── Auto-sync CSVs on startup ───────────────────────────────────────────
  useEffect(() => {
    const autoSync = async () => {
      const FILES = ["stdpartski.csv", "stdpartshy.csv"];
      try {
        for (const filename of FILES) {
          const res = await fetch(`https://csv-server-production-efc6.up.railway.app/file/${encodeURIComponent(filename)}`);
          if (!res.ok) continue;
          const text = await res.text();
          const parsed = parseKiaCSV(text);
          if (!parsed.length) continue;
          setKiaInvoices(prev => {
            const next = [...prev];
            parsed.forEach(newInv => {
              const existIdx = next.findIndex(e => e.id === newInv.id);
              if (existIdx === -1) { next.push(newInv); }
              else {
                next[existIdx] = { ...next[existIdx], orderRef: newInv.orderRef, totalLines: newInv.totalLines,
                  parts: newInv.parts.map(np => {
                    const ep = next[existIdx].parts.find(p => p.partNumber === np.partNumber && p.lineNo === np.lineNo);
                    return ep ? { ...np, confirmed: ep.confirmed, short: ep.short, shortQty: ep.shortQty } : np;
                  })
                };
              }
            });
            return next;
          });
          await AsyncStorage.setItem(`@csv_sync_${filename}`, String(Date.now()));
        }
      } catch (_) {}
    };
    autoSync();
  }, []);

  // ── Dispatch CSV auto-sync on startup (separate from KIA) ─────────────────
  useEffect(() => {
    const syncDispatch = async () => {
      try {
        const listRes = await fetch("https://csv-server-production-efc6.up.railway.app/files");
        if (!listRes.ok) return;
        const listJson = await listRes.json();
        const files = listJson.files || [];
        const dispatchFile = files.find(f => f.includes("INVOICE-SCAN-APP") || f.includes("04-INVOICE"));
        if (!dispatchFile) return;
        const res = await fetch(`https://csv-server-production-efc6.up.railway.app/file/${encodeURIComponent(dispatchFile)}`);
        if (!res.ok) return;
        const text = await res.text();
        const parsed = parseDispatchCSV(text);
        if (!parsed.length) return;
        setDispatchInvoices(prev => {
          const next = [...prev];
          parsed.forEach(newInv => {
            const existIdx = next.findIndex(e => e.id === newInv.id);
            if (existIdx === -1) { next.push(newInv); }
            else {
              next[existIdx] = {
                ...next[existIdx],
                customer: newInv.customer,
                reqDate: newInv.reqDate,
                closedInDMS: newInv.closedInDMS,
                parts: newInv.parts.map(np => {
                  const ep = next[existIdx].parts.find(p => p.partNumber === np.partNumber);
                  return ep ? { ...np, precounted: ep.precounted || 0, loaded: ep.loaded || 0, delivered: ep.delivered || 0 } : np;
                }),
              };
            }
          });
          return next;
        });
        const now = Date.now();
        await AsyncStorage.setItem(`@csv_sync_${dispatchFile}`, String(now));
        setFileMeta(prev => ({ ...prev, [dispatchFile]: { ...(prev[dispatchFile] || {}), appTime: now } }));
      } catch (_) {}
    };
    syncDispatch();
  }, []);
  const autoImportFile = async (filename) => {
    try {
      setWsStatus("pending");
      const res = await fetch(`${SERVER_URL}/file/${encodeURIComponent(filename)}`);
      const text = await res.text();
      const parsed = parseKiaCSV(text);
      if (!parsed.length) return;
      let added = 0, updated = 0;
      setKiaInvoices(prev => {
        const next = [...prev];
        parsed.forEach(newInv => {
          const existIdx = next.findIndex(e => e.id === newInv.id);
          if (existIdx === -1) { next.push(newInv); added++; }
          else {
            next[existIdx] = { ...next[existIdx], orderRef: newInv.orderRef, totalLines: newInv.totalLines,
              parts: newInv.parts.map(np => {
                const ep = next[existIdx].parts.find(p => p.partNumber === np.partNumber && p.lineNo === np.lineNo);
                return ep ? { ...np, confirmed: ep.confirmed, short: ep.short, shortQty: ep.shortQty } : np;
              })
            };
            updated++;
          }
        });
        return next;
      });
      const now = Date.now();
      await AsyncStorage.setItem(`@csv_sync_${filename}`, String(now));
      // Use the real saved time for the timestamp, then re-check overall status
      checkWatchStatus();
    } catch {}
  };

  const checkWatchStatus = async () => {
    try {
      const r = await fetch(`${SERVER_URL}/watch-status`);
      const j = await r.json();
      // Red: neither watch file on server
      if (!j.stdpartski && !j.stdpartshy) { setWsStatus("missing"); return; }
      const [ki, hy] = await Promise.all([
        AsyncStorage.getItem("@csv_sync_stdpartski.csv"),
        AsyncStorage.getItem("@csv_sync_stdpartshy.csv"),
      ]);
      const neverSynced = !ki && !hy;
      if (neverSynced) {
        // Auto-sync both on first connect — amber briefly then green
        if (j.stdpartski) autoImportFile("stdpartski.csv");
        if (j.stdpartshy) autoImportFile("stdpartshy.csv");
        return;
      }
      // Green — use the real AsyncStorage timestamp, not now
      const syncTime = Math.max(ki ? parseInt(ki) : 0, hy ? parseInt(hy) : 0);
      setWsStatus("updated");
      setWsLastSync(syncTime);
    } catch { setWsStatus(null); }
  };

  const connectWebSocket = () => {
    clearTimeout(wsReconnectRef.current);
    hasRejoinedRef.current = false; // Reset so startup-race effect can re-fire on reconnect
    const ws = new WebSocket(WS_SERVER);
    wsRef.current = ws;
    ws.onopen = () => {
      wsRetryDelayRef.current = 5000; // Reset backoff on successful connect
      checkWatchStatus();
      // Identify ourselves to server
      const identity = userIdentityRef.current;
      if (identity) ws.send(JSON.stringify({ type: "identify", ...identity }));
      // Rejoin room if we had one
      const roomId = currentRoomIdRef.current;
      if (roomId && identity) {
        hasRejoinedRef.current = true; // Prevent startup-race useEffect from double-joining
        ws.send(JSON.stringify({
          type: "join_room", roomId,
          userId: identity.id, initials: identity.initials,
          color: identity.color, name: identity.name, mergeMode: "merge",
        }));
      }
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);

        // Respond to server keepalive ping so Railway doesn't close idle connections
        if (msg.type === "ping") { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "pong" })); return; }

        // Host receives a join request from another phone
        if (msg.type === "join_request") {
          setIncomingJoinReq({
            requesterId: msg.requesterId,
            requesterInitials: msg.requesterInitials,
            requesterColor: msg.requesterColor,
            requesterName: msg.requesterName,
            roomId: msg.roomId,
          });
          return;
        }

        // Phone 2 receives response to their join request
        if (msg.type === "join_response") {
          if (msg.approved) {
            // Auto-join the room
            ws.send(JSON.stringify({
              type: "join_room",
              roomId: msg.roomId,
              userId: userIdentityRef.current?.id,
              initials: userIdentityRef.current?.initials,
              color: userIdentityRef.current?.color,
              name: userIdentityRef.current?.name,
              mergeMode: "merge",
            }));
            setCurrentRoomId(msg.roomId);
            setRoomName(msg.roomName);
          } else {
            Alert.alert("Join Declined", "The host declined your request to join.");
          }
          return;
        }

        // CSV file sync (existing)
        if (msg.type === "new_file" && msg.filename) { autoImportFile(msg.filename); return; }

        // Room created
        if (msg.type === "room_created") { setCurrentRoomId(msg.roomId); setRoomName(msg.roomName); setIsRoomHost(true); return; }

        // Room joined — apply remote board state
        if (msg.type === "room_joined") {
          setRoomName(msg.roomName);
          setRoomMembers(msg.members || []);
          setIsRoomHost(msg.hostId === userIdentityRef.current?.id);
          // focusList from host — used to decide which invoices get manuallyAdded
          const remoteFocusList = msg.focusList || [];
          const remotePinnedIds = msg.pinnedIds || [];
          if (msg.invoices && msg.invoices.length > 0) {
            setKiaInvoices(prev => {
              const next = [...prev];
              msg.invoices.forEach(ri => {
                const ei = next.findIndex(e => e.id === ri.id);
                if (ei === -1) {
                  // Invoice not local — take it fully from remote including its manuallyAdded state
                  next.push({ ...ri, removedFromBoard: false });
                } else {
                  // Existing invoice — merge parts trusting remote confirmed over local zero
                  const mergedParts = ri.parts.map(rp => {
                    const lp = next[ei].parts.find(p => p.partNumber === rp.partNumber && p.lineNo === rp.lineNo);
                    if (!lp) return rp;
                    const remoteWins = rp.confirmed > lp.confirmed || rp.short;
                    return remoteWins
                      ? { ...rp }
                      : { ...rp, confirmed: lp.confirmed, short: lp.short, shortQty: lp.shortQty,
                          confirmedBy: lp.confirmedBy, confirmedColor: lp.confirmedColor, confirmedAt: lp.confirmedAt };
                  });
                  const done = mergedParts.every(p => p.short || p.confirmed >= p.qty);
                  next[ei] = { ...next[ei], ...ri,
                    // Trust host's manuallyAdded — they control the board layout
                    manuallyAdded: ri.manuallyAdded || next[ei].manuallyAdded,
                    removedFromBoard: false,
                    parts: mergedParts, complete: ri.complete || done || next[ei].complete,
                    completedAt: ri.completedAt || next[ei].completedAt };
                }
              });
              return next;
            });
          }
          // Apply any remaining invoiceUpdates (catches parts confirmed after last room.invoices save)
          if (msg.invoiceUpdates && Object.keys(msg.invoiceUpdates).length > 0) {
            setKiaInvoices(prev => applyInvoiceUpdates(prev, msg.invoiceUpdates));
          }
          // Always replace focusList/pinnedIds from host — they are the source of truth for board layout
          setKiaFocusList(remoteFocusList);
          setKiaPinnedIds(remotePinnedIds);
          return;
        }

        // Someone joined
        if (msg.type === "member_joined") { setRoomMembers(msg.presence || []); return; }

        // Someone left / kicked
        if (msg.type === "member_left") { setRoomMembers(msg.presence || []); return; }
        if (msg.type === "presence_update") { setRoomMembers(msg.presence || []); return; }
        if (msg.type === "host_changed") { setIsRoomHost(msg.newHostId === userIdentityRef.current?.id); return; }

        // Kicked from room
        if (msg.type === "kicked") {
          setCurrentRoomId(null); setRoomName(null); setRoomMembers([]); setIsRoomHost(false);
          Alert.alert("Removed", "You were removed from the shared board.");
          return;
        }

        // Part confirmed by someone else
        if (msg.type === "part_update") {
          setKiaInvoices(prev => prev.map(inv => {
            if (inv.id !== msg.invId) return inv;
            const parts = inv.parts.map(p => {
              const key = p.partNumber + "_" + (p.lineNo || "0");
              if (key !== msg.partKey) return p;
              return { ...p, confirmed: msg.confirmed, short: msg.short, shortQty: msg.shortQty,
                confirmedBy: msg.initials, confirmedColor: msg.color, confirmedAt: msg.timestamp };
            });
            const done = parts.every(p => p.short || p.confirmed >= p.qty);
            // Do NOT use "done || inv.complete" — that prevents complete from going back to false on reset
            return { ...inv, parts, complete: done,
              completedAt: done ? (inv.completedAt || msg.timestamp) : 0 };
          }));
          return;
        }

        // Full sync — merge everyone's latest state silently
        if (msg.type === "full_sync") {
          if (msg.invoices && msg.invoices.length > 0) {
            setKiaInvoices(prev => {
              const next = [...prev];
              msg.invoices.forEach(ri => {
                const ei = next.findIndex(e => e.id === ri.id);
                if (ei === -1) {
                  // New invoice — trust host's manuallyAdded state
                  next.push({ ...ri, removedFromBoard: false });
                } else {
                  const mergedParts = ri.parts.map(rp => {
                    const lp = next[ei].parts.find(p => p.partNumber === rp.partNumber && p.lineNo === rp.lineNo);
                    if (!lp) return rp;
                    return (rp.confirmed >= lp.confirmed || rp.short)
                      ? { ...rp }
                      : { ...rp, confirmed: lp.confirmed, short: lp.short, shortQty: lp.shortQty,
                          confirmedBy: lp.confirmedBy, confirmedColor: lp.confirmedColor, confirmedAt: lp.confirmedAt };
                  });
                  const done = mergedParts.every(p => p.short || p.confirmed >= p.qty);
                  // Preserve existing manuallyAdded — don't force all invoices onto board
                  next[ei] = { ...next[ei], ...ri,
                    manuallyAdded: next[ei].manuallyAdded,
                    removedFromBoard: next[ei].removedFromBoard,
                    parts: mergedParts, complete: ri.complete || done || next[ei].complete,
                    completedAt: ri.completedAt || next[ei].completedAt };
                }
              });
              return next;
            });
          }
          // Apply invoiceUpdates on top for anything not yet in invoices
          if (msg.invoiceUpdates && Object.keys(msg.invoiceUpdates).length > 0) {
            setKiaInvoices(prev => applyInvoiceUpdates(prev, msg.invoiceUpdates));
          }
          return;
        }
        if (msg.type === "invoices_synced") {
          if (msg.invoices && msg.invoices.length > 0) {
            setKiaInvoices(prev => {
              const next = [...prev];
              msg.invoices.forEach(ri => {
                const ei = next.findIndex(e => e.id === ri.id);
                if (ei === -1) { next.push({ ...ri, removedFromBoard: false }); }
                else {
                  const mergedParts = ri.parts.map(rp => {
                    const lp = next[ei].parts.find(p => p.partNumber === rp.partNumber && p.lineNo === rp.lineNo);
                    if (!lp) return rp;
                    return (rp.confirmed >= lp.confirmed || rp.short)
                      ? { ...rp }
                      : { ...rp, confirmed: lp.confirmed, short: lp.short, shortQty: lp.shortQty,
                          confirmedBy: lp.confirmedBy, confirmedColor: lp.confirmedColor, confirmedAt: lp.confirmedAt };
                  });
                  const done = mergedParts.every(p => p.short || p.confirmed >= p.qty);
                  next[ei] = { ...next[ei], ...ri,
                    manuallyAdded: next[ei].manuallyAdded,
                    removedFromBoard: next[ei].removedFromBoard,
                    parts: mergedParts, complete: ri.complete || done || next[ei].complete,
                    completedAt: ri.completedAt || next[ei].completedAt };
                }
              });
              return next;
            });
          }
          return;
        }
        // Focus list changed by someone else
        if (msg.type === "focuslist_update") {
          setKiaFocusList(msg.focusList || []);
          setKiaPinnedIds(msg.pinnedIds || []);
          return;
        }

        // Invoice marked complete by someone else
        if (msg.type === "invoice_complete") {
          setKiaInvoices(prev => prev.map(inv =>
            inv.id === msg.invId ? { ...inv, complete: true, completedAt: msg.timestamp, completedBy: msg.initials } : inv
          ));
          return;
        }

        // Invoice reset by someone else — clear complete flag and all part confirms
        if (msg.type === "invoice_reset") {
          setKiaInvoices(prev => prev.map(inv =>
            inv.id !== msg.invId ? inv : {
              ...inv, complete: false, completedAt: 0, completedBy: "",
              parts: inv.parts.map(p => ({ ...p, confirmed: 0, short: false, shortQty: null, confirmedBy: "", confirmedColor: "", confirmedAt: 0 }))
            }
          ));
          return;
        }

      } catch(e) { console.error("WS message parse error:", e); }
    };
    ws.onerror = () => { setWsStatus("offline"); };
    ws.onclose = () => {
      setWsStatus("connecting");
      // Exponential backoff: 5s → 10s → 20s → 40s → max 60s
      const delay = wsRetryDelayRef.current;
      wsRetryDelayRef.current = Math.min(delay * 2, 60000);
      wsReconnectRef.current = setTimeout(() => connectWebSocket(), delay);
    };
  };

  useEffect(() => {
    connectWebSocket();
    // Reconnect WS when app comes back to foreground (e.g. returning from Outlook)
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        const ws = wsRef.current;
        if (!ws || ws.readyState === 3 /* CLOSED */) {
          clearTimeout(wsReconnectRef.current);
          connectWebSocket();
        }
      }
    });
    return () => {
      sub.remove();
      clearTimeout(wsReconnectRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // ── Poll active boards every 8s for the avatar join strip ──────────────
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(`${HTTP_SERVER}/rooms`);
        if (!res.ok) return;
        const json = await res.json();
        setActiveBoards(json.rooms || []);
      } catch(e) { console.error("activeBoards poll:", e); }
    };
    poll();
    const interval = setInterval(poll, 8000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!serverPickerVisible && pendingLocalImport) {
      setPendingLocalImport(false);
      setTimeout(() => handleKiaImportCSV(), 300);
    }
  }, [serverPickerVisible]);

  // ── CSV Import ───────────────────────────────────────────────────────────
  const handleKiaImportCSV = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ["text/csv", "text/comma-separated-values", "application/csv", "*/*"] });
      if (result.canceled) return;
      const file = result.assets?.[0] || result;
      const uri = file.uri;
      setImporting(true);
      const response = await fetch(uri);
      const text = await response.text();

      // Auto-detect format from header
      const firstLine = text.split(/\r?\n/)[0].toUpperCase();
      const isDispatchFormat = firstLine.includes("INV#") && firstLine.includes("CNAME");

      if (isDispatchFormat) {
        const parsed = parseDispatchCSV(text);
        if (!parsed.length) { setImporting(false); Alert.alert("No data", "Could not read any dispatch invoices from that file."); return; }
        setDispatchInvoices(prev => {
          const next = [...prev];
          parsed.forEach(newInv => {
            const existIdx = next.findIndex(e => e.id === newInv.id);
            if (existIdx === -1) { next.push(newInv); }
            else {
              next[existIdx] = { ...next[existIdx], customer: newInv.customer, reqDate: newInv.reqDate, closedInDMS: newInv.closedInDMS,
                parts: newInv.parts.map(np => {
                  const ep = next[existIdx].parts.find(p => p.partNumber === np.partNumber);
                  return ep ? { ...np, precounted: ep.precounted || 0, loaded: ep.loaded || 0, delivered: ep.delivered || 0 } : np;
                })
              };
            }
          });
          return next;
        });
        setImporting(false);
        setImportResult({ added: parsed.length, updated: 0 });
        return;
      }

      // KIA format
      const parsed = parseKiaCSV(text);
      if (!parsed.length) { setImporting(false); Alert.alert("No data", "Could not read any KIA invoices from that file."); return; }
      let added = 0, updated = 0;
      setKiaInvoices(prev => {
        const next = [...prev];
        parsed.forEach(newInv => {
          const existIdx = next.findIndex(e => e.id === newInv.id);
          if (existIdx === -1) { next.push(newInv); added++; }
          else {
            next[existIdx] = { ...next[existIdx], orderRef: newInv.orderRef, totalLines: newInv.totalLines,
              parts: newInv.parts.map(np => {
                const ep = next[existIdx].parts.find(p => p.partNumber === np.partNumber && p.lineNo === np.lineNo);
                return ep ? { ...np, confirmed: ep.confirmed, short: ep.short, shortQty: ep.shortQty } : np;
              })
            };
            updated++;
          }
        });
        return next;
      });
      setImporting(false);
      setImportResult({ added, updated });
    } catch (e) {
      setImporting(false);
      Alert.alert("Import Error", String(e));
    }
  };

  const SERVER_URL = "https://csv-server-production-efc6.up.railway.app";

  const deleteServerFile = async (filename) => {
    Alert.alert("Delete File?", `Remove "${filename}" from the server?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => {
        try {
          await fetch(`${SERVER_URL}/file/${encodeURIComponent(filename)}`, { method: "DELETE" });
          setServerFiles(prev => prev.filter(f => f !== filename));
        } catch (e) {
          Alert.alert("Delete Error", String(e));
        }
      }},
    ]);
  };

  const handleKiaFetchFromServer = async () => {
    try {
      setServerFetching(true);
      const res = await fetch(`${SERVER_URL}/files`);
      const json = await res.json();
      setServerFiles(json.files || []);
      // Load timestamps for all files
      const meta = {};
      await Promise.all((json.files || []).map(async (fname) => {
        try {
          const r = await fetch(`${SERVER_URL}/file-meta/${encodeURIComponent(fname)}`);
          const m = await r.json();
          const appRaw = await AsyncStorage.getItem(`@csv_sync_${fname}`);
          meta[fname] = { serverTime: m.uploadedAt || null, appTime: appRaw ? parseInt(appRaw) : null };
        } catch { meta[fname] = { serverTime: null, appTime: null }; }
      }));
      setFileMeta(meta);
      setServerFetching(false);
      setServerPickerVisible(true);
    } catch (e) {
      setServerFetching(false);
      Alert.alert("Server Error", "Could not reach the CSV server.\n\n" + String(e));
    }
  };

  const handleServerFileSelect = async (filename) => {
    setServerPickerVisible(false);
    try {
      setImporting(true);
      const res = await fetch(`${SERVER_URL}/file/${encodeURIComponent(filename)}`);
      const text = await res.text();

      // Auto-detect format from header
      const firstLine = text.split(/\r?\n/)[0].toUpperCase();
      const isDispatchFormat = firstLine.includes("INV#") && firstLine.includes("CNAME");

      // Dispatch CSV
      if (isDispatchFormat) {
        const parsed = parseDispatchCSV(text);
        if (!parsed.length) { setImporting(false); Alert.alert("No data", "Could not read any dispatch invoices from that file."); return; }
        let added = 0, updated = 0;
        setDispatchInvoices(prev => {
          const next = [...prev];
          parsed.forEach(newInv => {
            const existIdx = next.findIndex(e => e.id === newInv.id);
            if (existIdx === -1) { next.push(newInv); added++; }
            else {
              next[existIdx] = { ...next[existIdx], customer: newInv.customer, reqDate: newInv.reqDate, closedInDMS: newInv.closedInDMS,
                parts: newInv.parts.map(np => {
                  const ep = next[existIdx].parts.find(p => p.partNumber === np.partNumber);
                  return ep ? { ...np, precounted: ep.precounted || 0, loaded: ep.loaded || 0, delivered: ep.delivered || 0 } : np;
                })
              };
              updated++;
            }
          });
          return next;
        });
        // Count outside setState to avoid closure issue
        const existingIds = new Set((await AsyncStorage.getItem("@dispatch_invoices_v1") ? JSON.parse(await AsyncStorage.getItem("@dispatch_invoices_v1") || "[]") : []).map(i => i.id));
        const addedCount = parsed.filter(i => !existingIds.has(i.id)).length;
        const updatedCount = parsed.length - addedCount;
        setImporting(false);
        setImportResult({ added: addedCount, updated: updatedCount });
        await AsyncStorage.setItem(`@csv_sync_${filename}`, String(Date.now()));
        setFileMeta(prev => ({ ...prev, [filename]: { ...(prev[filename] || {}), appTime: Date.now() } }));
        return;
      }

      // KIA CSV
      const parsed = parseKiaCSV(text);
      if (!parsed.length) { setImporting(false); Alert.alert("No data", "Could not read any KIA invoices from that file."); return; }
      let added = 0, updated = 0;
      setKiaInvoices(prev => {
        const next = [...prev];
        parsed.forEach(newInv => {
          const existIdx = next.findIndex(e => e.id === newInv.id);
          if (existIdx === -1) { next.push(newInv); added++; }
          else {
            next[existIdx] = { ...next[existIdx], orderRef: newInv.orderRef, totalLines: newInv.totalLines,
              parts: newInv.parts.map(np => {
                const ep = next[existIdx].parts.find(p => p.partNumber === np.partNumber && p.lineNo === np.lineNo);
                return ep ? { ...np, confirmed: ep.confirmed, short: ep.short, shortQty: ep.shortQty } : np;
              })
            };
            updated++;
          }
        });
        return next;
      });
      setImporting(false);
      setImportResult({ added, updated });
      await AsyncStorage.setItem(`@csv_sync_${filename}`, String(Date.now()));
      setFileMeta(prev => ({ ...prev, [filename]: { ...(prev[filename] || {}), appTime: Date.now() } }));
    } catch (e) {
      setImporting(false);
      Alert.alert("Download Error", String(e));
    }
  };

  const handleKiaPartLookup = (input) => {
    if (input === "camera") { setKiaPartLookupCamera(true); return; }
    if (String(input).startsWith('__RAW__')) { kiaPartLookupRawRef.current = String(input).slice(7); return; }
    setKiaPartLookupCamera(false);
    const raw = String(input).trim().toUpperCase();

    const extraRaw = (kiaPartLookupRawRef.current || '').toUpperCase();
    kiaPartLookupRawRef.current = null;
    const allParts = [];
    dispatchInvoices.forEach(inv => inv.parts.forEach(p => { if (p.partNumber) allParts.push({ partNumber: p.partNumber }); }));
    const parsed = parsePartNumber(raw, allParts);
    const candidates = new Set();
    if (parsed && typeof parsed === 'string') candidates.add(parsed);
    if (parsed && typeof parsed === 'object' && parsed.digits) candidates.add(parsed.digits);
    candidates.add(raw);
    if (extraRaw && extraRaw !== raw) {
      candidates.add(extraRaw);
      const parsedExtra = parsePartNumber(extraRaw, allParts);
      if (parsedExtra && typeof parsedExtra === 'string') candidates.add(parsedExtra);
      if (parsedExtra && typeof parsedExtra === 'object' && parsedExtra.digits) candidates.add(parsedExtra.digits);
    }
    const prefixes = ['HY','KI','IS','BY','TO','HO','MI','NI','SU','MA','MZ'];
    for (const src of [raw, extraRaw].filter(Boolean)) {
      let prefixStripped = src;
      for (const pfx of prefixes) {
        if (src.startsWith(pfx)) { prefixStripped = src.slice(pfx.length); candidates.add(prefixStripped); break; }
      }
      const prodCodeStripped = prefixStripped.replace(/[A-Z]{1,4}\d{1,3}$/, '');
      if (prodCodeStripped !== prefixStripped && prodCodeStripped.length >= 6) candidates.add(prodCodeStripped);
      const srcProdStripped = src.replace(/[A-Z]{1,4}\d{1,3}$/, '');
      if (srcProdStripped !== src && srcProdStripped.length >= 6) candidates.add(srcProdStripped);
    }
    const matches = [];
    dispatchInvoices.forEach(inv => {
      if (kiaHideClosedInvoices && inv.closedInDMS) return;
      let part = null;
      // 1. Exact candidate match
      for (const c of candidates) {
        part = inv.parts.find(p => p.partNumber === c || p.partNumber === c.toUpperCase());
        if (part) break;
      }
      // 2. Substring fallback
      if (!part) {
        for (const c of candidates) {
          if (c.length < 6) continue;
          part = inv.parts.find(p => { const db = p.partNumber.toUpperCase(); const cand = c.toUpperCase(); return db.includes(cand) || cand.includes(db); });
          if (part) break;
        }
      }
      // 3. Strip non-alphanumeric fallback
      if (!part) {
        const digitCore = (s) => s.replace(/[^A-Z0-9]/g, '');
        for (const c of candidates) {
          const cCore = digitCore(c.toUpperCase());
          if (cCore.length < 7) continue;
          part = inv.parts.find(p => { const dbCore = digitCore(p.partNumber.toUpperCase()); return dbCore === cCore || dbCore.includes(cCore) || cCore.includes(dbCore); });
          if (part) break;
        }
      }
      if (!part) return;
      const active = inv.parts.filter(p => !p.backorder);
      let status = inv.closedInDMS ? "CLOSED" : "OPEN";
      if (inv.locked) status = "DELIVERED";
      else if (active.every(p => (p.loaded||0) >= p.expected)) status = "ON VAN";
      else if (active.some(p => (p.loaded||0) > 0)) status = "LOADING";
      else if (inv.precounted) status = "PRECOUNTED";
      matches.push({ invId: inv.id, customer: inv.customer, reqDate: inv.reqDate, status, part });
    });
    const displayPN = matches.length > 0 ? matches[0].part.partNumber : (parsed && typeof parsed === 'string' ? parsed : raw);
    setKiaPartLookupResult({ partNumber: displayPN, matches });
  };

  const handleKiaClearAll = () => {
    Alert.alert("Clear KIA Receiving Data?", "This will remove all KIA invoices and receiving history.", [
      { text: "Cancel", style: "cancel" },
      { text: "Clear All", style: "destructive", onPress: () => {
        setKiaInvoices([]);
        setActiveKiaId(null);
        setKiaScreen("home");
        setKiaLastScanned(null);
        setDispatchInvoices([]);
        AsyncStorage.removeItem(KIA_STORAGE_KEY).catch(() => {});
        AsyncStorage.removeItem("@kia_lastscanned_v1").catch(() => {});
        AsyncStorage.removeItem("@dispatch_invoices_v1").catch(() => {});
        AsyncStorage.getAllKeys().then(keys => {
          const detailKeys = keys.filter(k => k.startsWith("@kia_lastscanned_detail_"));
          if (detailKeys.length) AsyncStorage.multiRemove(detailKeys).catch(() => {});
        }).catch(() => {});
      }}
    ]);
  };

  const partsDB = kiaInvoices.flatMap(inv => inv.parts.map(p => ({ partNumber: p.partNumber })));

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      {showDispatchPrecount && dispatchInvoices.find(i => i.id === activeDispatchId) ? (
        <DispatchPreCountScreen
          invoice={dispatchInvoices.find(i => i.id === activeDispatchId)}
          onBack={() => { setShowDispatchPrecount(false); setActiveDispatchId(null); }}
          onComplete={() => { setShowDispatchPrecount(false); setActiveDispatchId(null); }}
          setDispatchInvoices={setDispatchInvoices}
          torchEnabled={torchEnabled}
          hideBackorderCol={hideBackorderCol}
          setHideBackorderCol={setHideBackorderCol}
        />
      ) : kiaScreen === "home" ? (
        <KiaHomeScreen
          invoices={kiaInvoices}
          onImportCSV={handleKiaImportCSV}
          onFetchFromServer={handleKiaFetchFromServer}
          onClearAll={handleKiaClearAll}
          onOpenList={() => setKiaScreen("board")}
          onFindPart={() => setKiaScreen("findpart")}
          torchEnabled={torchEnabled}
          setTorchEnabled={setTorchEnabled}
          appMode="receiving"
          setAppMode={() => {}}
          onScanFindPart={(input) => {
            if (input === "camera") { setKiaFindCamera(true); return; }
            setKiaFindCamera(false);
            const raw = String(input).trim().toUpperCase();
            const matches = [];
            kiaInvoices.forEach(inv => {
              const part = inv.parts.find(p => {
                const pn = p.partNumber.toUpperCase();
                return pn === raw || raw.includes(pn) || pn.includes(raw);
              });
              if (part) matches.push({ invId: inv.id, orderRef: inv.orderRef, complete: inv.complete, hasShort: inv.parts.some(p => p.short), part, invDate: inv.invDate, importedAt: inv.importedAt });
            });
            matches.sort((a, b) => (b.invDate || b.importedAt || 0) - (a.invDate || a.importedAt || 0));
          setKiaPartResult({ partNumber: raw, matches });
          }}
          kiaPartResult={kiaPartResult}
          setKiaPartResult={setKiaPartResult}
          onOpenInvoice={(id) => { setActiveKiaId(id); setKiaScreen("detail"); }}
          focusList={kiaFocusList}
          onOpenBoard={() => setKiaScreen("board")}
          onAddToPending={(ids) => {
            setKiaInvoices(prev => prev.map(inv =>
              ids.includes(inv.id.toUpperCase())
                ? { ...inv, manuallyAdded: true, removedFromBoard: false }
                : inv
            ));
          }}
          setFocusList={setKiaFocusList}
          wsStatus={wsStatus}
          wsLastSync={wsLastSync}
          activeBoards={activeBoards}
          userIdentity={userIdentity}
          wsRef={wsRef}
          currentRoomId={currentRoomId}
          onRequestJoin={(board) => {
            if (!wsRef.current || wsRef.current.readyState !== 1 || !userIdentity) return;
            wsRef.current.send(JSON.stringify({
              type: "join_request",
              roomId: board.roomId,
              userId: userIdentity.id,
              initials: userIdentity.initials,
              color: userIdentity.color,
              name: userIdentity.name,
            }));
            Alert.alert("Request Sent", `Asked to join ${board.roomName}. Waiting for host to approve.`);
          }}
          hideOrderRefs={kiaHideOrderRefs}
          setHideOrderRefs={setKiaHideOrderRefs}
          suppressNewInvAlert={kiaSuppressNewInv}
          setSuppressNewInvAlert={setKiaSuppressNewInv}
          dimOtherCards={kiaDimOtherCards}
          setDimOtherCards={setKiaDimOtherCards}
          hideFindBtn={kiaHideFindBtn}
          setHideFindBtn={setKiaHideFindBtn}
          onFindPartLookup={handleKiaPartLookup}
          partLookupResult={kiaPartLookupResult}
          setPartLookupResult={setKiaPartLookupResult}
          hideClosedInvoices={kiaHideClosedInvoices}
          setHideClosedInvoices={setKiaHideClosedInvoices}
          hideBackorderColProp={hideBackorderCol}
          setHideBackorderColProp={setHideBackorderCol}
          onOpenDispatchPrecount={(invId) => { setActiveDispatchId(invId); setShowDispatchPrecount(true); }}
          onExportEmail={() => {
            if (!kiaInvoices.length) { Alert.alert("Nothing to export", "No invoices loaded."); return; }
            setExportFilterVisible(true);
          }}
          onSilentSync={async () => {
            const FILES = ["stdpartski.csv", "stdpartshy.csv"];
            for (const filename of FILES) {
              try {
                const res = await fetch(`https://csv-server-production-efc6.up.railway.app/file/${encodeURIComponent(filename)}`);
                if (!res.ok) continue;
                const text = await res.text();
                const parsed = parseKiaCSV(text);
                if (!parsed.length) continue;
                setKiaInvoices(prev => {
                  const next = [...prev];
                  parsed.forEach(newInv => {
                    const existIdx = next.findIndex(e => e.id === newInv.id);
                    if (existIdx === -1) { next.push(newInv); }
                    else {
                      next[existIdx] = { ...next[existIdx], orderRef: newInv.orderRef, totalLines: newInv.totalLines,
                        parts: newInv.parts.map(np => {
                          const ep = next[existIdx].parts.find(p => p.partNumber === np.partNumber && p.lineNo === np.lineNo);
                          return ep ? { ...np, confirmed: ep.confirmed, short: ep.short, shortQty: ep.shortQty } : np;
                        })
                      };
                    }
                  });
                  return next;
                });
              } catch (_) {}
            }
          }}
          onDispatchSync={async () => {
            try {
              const listRes = await fetch("https://csv-server-production-efc6.up.railway.app/files");
              if (!listRes.ok) return;
              const listJson = await listRes.json();
              const files = listJson.files || [];
              const dispatchFile = files.find(f => f.includes("INVOICE-SCAN-APP") || f.includes("04-INVOICE"));
              if (!dispatchFile) return;
              const res = await fetch(`https://csv-server-production-efc6.up.railway.app/file/${encodeURIComponent(dispatchFile)}`);
              if (!res.ok) return;
              const text = await res.text();
              const parsed = parseDispatchCSV(text);
              if (!parsed.length) return;
              setDispatchInvoices(prev => {
                const next = [...prev];
                parsed.forEach(newInv => {
                  const existIdx = next.findIndex(e => e.id === newInv.id);
                  if (existIdx === -1) { next.push(newInv); }
                  else {
                    next[existIdx] = {
                      ...next[existIdx],
                      customer: newInv.customer,
                      reqDate: newInv.reqDate,
                      closedInDMS: newInv.closedInDMS,
                      parts: newInv.parts.map(np => {
                        const ep = next[existIdx].parts.find(p => p.partNumber === np.partNumber);
                        return ep ? { ...np, precounted: ep.precounted || 0, loaded: ep.loaded || 0, delivered: ep.delivered || 0 } : np;
                      }),
                    };
                  }
                });
                return next;
              });
              const now = Date.now();
              await AsyncStorage.setItem(`@csv_sync_${dispatchFile}`, String(now));
              setFileMeta(prev => ({ ...prev, [dispatchFile]: { ...(prev[dispatchFile] || {}), appTime: now } }));
            } catch (_) {}
          }}
          onManualInvoice={(id, mode) => {
            if (mode === "precount") {
              const inv = kiaInvoices.find(i => i.id === id);
              if (inv) { setActiveKiaId(id); setKiaScreen("detail"); }
              else Alert.alert("Not Found", `Invoice "${id}" is not in your KIA CSV. Import it first.`);
            } else {
              const raw = id.trim().toUpperCase();
              const matches = [];
              kiaInvoices.forEach(inv => {
                const part = inv.parts.find(p => {
                  const pn = p.partNumber.toUpperCase();
                  return pn === raw || raw.includes(pn) || pn.includes(raw);
                });
                if (part) matches.push({ invId: inv.id, orderRef: inv.orderRef, complete: inv.complete, hasShort: inv.parts.some(p => p.short), part, invDate: inv.invDate, importedAt: inv.importedAt });
              });
              setKiaPartResult({ partNumber: raw, matches });
            }
          }}
        />
      ) : kiaScreen === "board" ? (
        <KiaFocusBoard
          invoices={kiaInvoices}
          allInvoices={kiaInvoices}
          focusList={kiaFocusList}
          onSelect={(id) => { setKiaLastVisitedId(id); setKiaReturnScreen("board"); setActiveKiaId(id); setKiaScreen("detail"); }}
          onBack={() => setKiaScreen("home")}
          torchEnabled={torchEnabled}
          setKiaInvoices={setKiaInvoices}
          lastScanned={kiaLastScanned}
          setLastScanned={setKiaLastScanned}
          pinnedIds={kiaPinnedIds}
          setPinnedIds={setKiaPinnedIds}
          activeInvId={kiaActiveInvId}
          setActiveInvId={setKiaActiveInvId}
          pileCount={kiaPileCount}
          setPileCount={setKiaPileCount}
          hideOrderRefs={kiaHideOrderRefs}
          setHideOrderRefs={setKiaHideOrderRefs}
          suppressNewInvAlert={kiaSuppressNewInv}
          setSuppressNewInvAlert={setKiaSuppressNewInv}
          dimOtherCards={kiaDimOtherCards}
          setDimOtherCards={setKiaDimOtherCards}
          lastVisitedId={kiaLastVisitedId}
          setLastVisitedId={setKiaLastVisitedId}
          onFindPart={(autoScan) => { setKiaFindAutoScan(!!autoScan); setKiaScreen("findpart"); }}
          onFindPartOcr={() => { setKiaFindInitOcr(true); setKiaFindAutoScan(false); setKiaScreen("findpart"); }}
          onFindPartKeyboard={() => { setKiaFindInitKeyboard(true); setKiaFindAutoScan(false); setKiaScreen("findpart"); }}
          hideFindBtn={kiaHideFindBtn}
          userIdentity={userIdentity}
          wsRef={wsRef}
          currentRoomId={currentRoomId}
          roomName={roomName}
          roomMembers={roomMembers}
          setRoomMembers={setRoomMembers}
          isRoomHost={isRoomHost}
          onOpenSession={() => setShowSessionModal(true)}
          incomingJoinReq={incomingJoinReq}
          onRespondJoinReq={(approved) => {
            if (!incomingJoinReq || !wsRef.current || wsRef.current.readyState !== 1) return;
            wsRef.current.send(JSON.stringify({
              type: "join_response",
              requesterId: incomingJoinReq.requesterId,
              roomId: incomingJoinReq.roomId,
              roomName: roomName,
              approved,
            }));
            setIncomingJoinReq(null);
          }}
        />
      ) : kiaScreen === "detail" && kiaInvoices.find(i => i.id === activeKiaId) ? (
        <KiaDetailScreen
          invoice={kiaInvoices.find(i => i.id === activeKiaId)}
          onBack={() => { setKiaReturnScreen("board"); setKiaScreen("board"); }}
          setKiaInvoices={setKiaInvoices}
          torchEnabled={torchEnabled}
          initialPartNumber={kiaFindPartNumber}
          onClearInitialPart={() => setKiaFindPartNumber(null)}
          userIdentity={userIdentity}
          wsRef={wsRef}
          currentRoomId={currentRoomId}
        />
      ) : kiaScreen === "findpart" ? (
        <KiaFindPartScreen
          autoScan={kiaFindAutoScan}
          onAutoScanDone={() => setKiaFindAutoScan(false)}
          initialOcrMode={kiaFindInitOcr}
          initialKeyboardMode={kiaFindInitKeyboard}
          invoices={kiaInvoices}
          onBack={() => { setKiaFindQuery(""); setKiaFindInitOcr(false); setKiaFindInitKeyboard(false); setKiaScreen("board"); }}
          setKiaInvoices={setKiaInvoices}
          torchEnabled={torchEnabled}
          initialQuery={kiaFindQuery}
          onGoToDetail={(invId, pn) => { setKiaFindPartNumber(pn); setKiaReturnScreen("findpart"); setActiveKiaId(invId); setKiaScreen("detail"); }}
        />
      ) : null}

      {/* KIA scanners */}
      <BarcodeScanner
        visible={kiaPrecountCamera}
        title="Scan Invoice — KIA"
        onScanned={(s) => {
          setKiaPrecountCamera(false);
          const id = String(s).trim();
          const inv = kiaInvoices.find(i => i.id === id);
          if (inv) { setActiveKiaId(id); setKiaScreen("detail"); }
          else Alert.alert("Not Found", `Invoice "${id}" not in KIA CSV.`);
        }}
        onClose={() => setKiaPrecountCamera(false)}
        partsDB={[]}
        invoiceMode
        torchEnabled={torchEnabled}
      />
      <BarcodeScanner
        visible={kiaFindCamera}
        title="Scan Part — KIA"
        onScanned={(s) => {
          setKiaFindCamera(false);
          const raw = String(s).trim().toUpperCase();
          const matches = [];
          kiaInvoices.forEach(inv => {
            const part = inv.parts.find(p => {
              const pn = p.partNumber.toUpperCase();
              return pn === raw || raw.includes(pn) || pn.includes(raw);
            });
            if (part) matches.push({ invId: inv.id, orderRef: inv.orderRef, complete: inv.complete, hasShort: inv.parts.some(p => p.short), part, invDate: inv.invDate, importedAt: inv.importedAt });
          });
          setKiaPartResult({ partNumber: raw, matches });
        }}
        onClose={() => setKiaFindCamera(false)}
        partsDB={partsDB}
        torchEnabled={torchEnabled}
      />

      <BarcodeScanner
        visible={kiaPartLookupCamera}
        title="Scan Part — Find Invoice"
        onScanned={handleKiaPartLookup}
        onClose={() => setKiaPartLookupCamera(false)}
        partsDB={dispatchInvoices.flatMap(inv => inv.parts.map(p => ({ partNumber: p.partNumber })))}
        deliverRaw
        torchEnabled={torchEnabled}
        onInvoiceKeyboard={() => { setKiaPartLookupCamera(false); setInvoiceLookupText(""); setTimeout(() => setInvoiceLookupVisible(true), 350); }}
      />

      {/* ── Invoice number keyboard lookup — Trace to Invoice screen only ── */}
      <Modal visible={invoiceLookupVisible} transparent animationType="slide" onRequestClose={() => setInvoiceLookupVisible(false)} onShow={() => setTimeout(() => invoiceLookupInputRef.current?.focus(), 100)}>
        <TouchableOpacity style={{ flex: 1, backgroundColor: "#00000088" }} activeOpacity={1} onPress={() => setInvoiceLookupVisible(false)} />
        <View style={{ backgroundColor: C.s1, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 48 }}>
          <View style={{ alignSelf: "center", width: 40, height: 4, backgroundColor: C.b1, borderRadius: 2, marginBottom: 20 }} />
          <Text style={{ color: C.t2, fontSize: 12, fontWeight: "900", letterSpacing: 1.5, marginBottom: 8 }}>PANEL SHOP INVOICE LOOKUP</Text>
          <TextInput
            ref={invoiceLookupInputRef}
            value={invoiceLookupText}
            onChangeText={setInvoiceLookupText}
            placeholder="Invoice number e.g. 16XXXXX"
            placeholderTextColor={C.t3}
            autoCapitalize="characters"
            returnKeyType="done"
            onSubmitEditing={() => {
              const val = invoiceLookupText.trim().toUpperCase();
              if (!val) return;
              setInvoiceLookupVisible(false);
              const inv = dispatchInvoices.find(i => i.id.toUpperCase() === val) || dispatchInvoices.find(i => i.id.toUpperCase().startsWith("16") && i.id.toUpperCase().includes(val));
              if (inv) { setActiveDispatchId(inv.id); setShowDispatchPrecount(true); }
              else Alert.alert("Not Found", `Invoice "${val}" not found in Dispatch CSV.`);
            }}
            style={{ backgroundColor: C.s2, borderRadius: 14, padding: 18, color: C.t1, fontSize: 20, fontWeight: "900", borderWidth: 1.5, borderColor: C.blue + "66", letterSpacing: 1, marginBottom: 14 }}
          />
          <TouchableOpacity
            onPress={() => {
              const val = invoiceLookupText.trim().toUpperCase();
              if (!val) return;
              setInvoiceLookupVisible(false);
              const inv = dispatchInvoices.find(i => i.id.toUpperCase() === val) || dispatchInvoices.find(i => i.id.toUpperCase().startsWith("16") && i.id.toUpperCase().includes(val));
              if (inv) { setActiveDispatchId(inv.id); setShowDispatchPrecount(true); }
              else Alert.alert("Not Found", `Invoice "${val}" not found in Dispatch CSV.`);
            }}
            style={{ backgroundColor: C.blue, borderRadius: 16, paddingVertical: 18, alignItems: "center" }}
            activeOpacity={0.85}>
            <Text style={{ color: C.bg, fontSize: 18, fontWeight: "900" }}>Open Invoice</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { setInvoiceLookupVisible(false); setKiaPartLookupCamera(true); }} style={{ paddingVertical: 14, alignItems: "center" }}>
            <Text style={{ color: C.t3, fontSize: 15 }}>Back to Scanner</Text>
          </TouchableOpacity>
        </View>
      </Modal>

      {/* Import result modal */}
      <Modal visible={!!importResult} transparent animationType="fade">
        <View style={{ flex: 1, backgroundColor: "#00000066", alignItems: "center", justifyContent: "center", padding: 32 }}>
          <View style={{ backgroundColor: C.s1, borderRadius: 20, padding: 28, alignItems: "center", borderWidth: 1, borderColor: C.green + "55", width: "100%" }}>
            <Ionicons name="checkmark-circle" size={52} color={C.green} style={{ marginBottom: 14 }} />
            <Text style={{ color: C.t1, fontSize: 22, fontWeight: "900", marginBottom: 8 }}>CSV Imported!</Text>
            <Text style={{ color: C.t3, fontSize: 16, textAlign: "center", marginBottom: 24 }}>
              {importResult?.added} new invoice{importResult?.added !== 1 ? "s" : ""} added{importResult?.updated > 0 ? `, ${importResult.updated} refreshed` : ""}
            </Text>
            <TouchableOpacity onPress={() => setImportResult(null)} style={{ backgroundColor: C.green, borderRadius: 14, padding: 18, width: "100%", alignItems: "center" }}>
              <Text style={{ color: C.bg, fontSize: 18, fontWeight: "900" }}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Importing spinner */}
      <Modal visible={importing} transparent animationType="fade">
        <View style={{ flex: 1, backgroundColor: "#00000088", alignItems: "center", justifyContent: "center" }}>
          <View style={{ backgroundColor: C.s2, borderRadius: 20, padding: 32, alignItems: "center", borderWidth: 1, borderColor: C.b1 }}>
            <MaterialCommunityIcons name="file-import-outline" size={40} color={C.blue} style={{ marginBottom: 14 }} />
            <Text style={{ color: C.t1, fontWeight: "800", fontSize: 17 }}>Importing CSV...</Text>
          </View>
        </View>
      </Modal>
      {/* Server file picker modal */}
      <Modal visible={serverPickerVisible} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: "#00000088", justifyContent: "flex-end" }}>
          <View style={{ backgroundColor: C.s1, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 36, maxHeight: "70%" }}>
            <View style={{ alignSelf: "center", width: 40, height: 4, backgroundColor: C.b1, borderRadius: 2, marginBottom: 20 }} />
            <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 20, gap: 10 }}>
              <MaterialCommunityIcons name="server-network" size={24} color={C.green} />
              <Text style={{ color: C.t1, fontSize: 20, fontWeight: "900", flex: 1 }}>Pick a CSV File</Text>
              <TouchableOpacity onPress={() => { setPendingLocalImport(true); setServerPickerVisible(false); }} activeOpacity={0.8}
                style={{ backgroundColor: C.s2, borderRadius: 12, borderWidth: 1.5, borderColor: C.green + "66", padding: 10, marginRight: 6 }}>
                <Ionicons name="cloud-upload-outline" size={22} color={C.green} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setServerPickerVisible(false)} style={{ padding: 6 }}>
                <Ionicons name="close" size={24} color={C.t3} />
              </TouchableOpacity>
            </View>
            {serverFiles.length === 0 ? (
              <View style={{ alignItems: "center", padding: 32 }}>
                <MaterialCommunityIcons name="file-outline" size={40} color={C.t3} style={{ marginBottom: 12 }} />
                <Text style={{ color: C.t3, fontSize: 16 }}>No CSV files on server yet</Text>
              </View>
            ) : (
              <ScrollView>
                {serverFiles.map(filename => {
                  const meta = fileMeta[filename] || {};
                  const isDispatch = filename.includes("INVOICE-SCAN-APP") || filename.includes("04-INVOICE");
                  const isStdFile = filename === "stdpartski.csv" || filename === "stdpartshy.csv" || isDispatch;
                  const hasUpdate = isStdFile && meta.serverTime && (!meta.appTime || meta.serverTime > meta.appTime);
                  const isUpToDate = isStdFile && !!meta.appTime && (!meta.serverTime || meta.appTime >= meta.serverTime);
                  const neverSynced = isStdFile && !meta.appTime;
                  const dotColor = !isStdFile ? null : hasUpdate ? C.amber : isUpToDate ? C.green : C.t3;
                  const fmtTime = (ts) => ts ? new Date(ts).toLocaleString("en-AU", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
                  return (
                    <View key={filename}>
                      <View style={{ backgroundColor: C.s2, borderRadius: 14, marginBottom: syncPopover === filename ? 0 : 10, flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: hasUpdate ? C.amber + "55" : C.b1, overflow: "hidden", borderBottomLeftRadius: syncPopover === filename ? 0 : 14, borderBottomRightRadius: syncPopover === filename ? 0 : 14 }}>
                        <TouchableOpacity onPress={() => handleServerFileSelect(filename)} onLongPress={() => isStdFile && setSyncPopover(syncPopover === filename ? null : filename)} delayLongPress={400} activeOpacity={0.8}
                          style={{ flex: 1, padding: 18, flexDirection: "row", alignItems: "center", gap: 14 }}>
                          <MaterialCommunityIcons name="file-delimited-outline" size={28} color={C.green} />
                          <Text style={{ color: C.t1, fontSize: 16, fontWeight: "700", flex: 1 }} numberOfLines={1}>{filename}</Text>
                          {dotColor && <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: dotColor, marginRight: 4 }} />}
                          <Ionicons name="cloud-download-outline" size={20} color={C.t3} />
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => deleteServerFile(filename)} activeOpacity={0.8}
                          style={{ padding: 18, borderLeftWidth: 1, borderLeftColor: C.b1 }}>
                          <Ionicons name="trash-outline" size={20} color={C.red} />
                        </TouchableOpacity>
                      </View>
                      {syncPopover === filename && (
                        <View style={{ backgroundColor: C.s3, borderRadius: 0, borderBottomLeftRadius: 14, borderBottomRightRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderTopWidth: 0, borderColor: hasUpdate ? C.amber + "55" : C.b1 }}>
                          <Text style={{ color: C.t3, fontSize: 10, fontWeight: "900", letterSpacing: 1.5, marginBottom: 10 }}>SYNC INFO</Text>
                          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
                            <Text style={{ color: C.t3, fontSize: 12 }}>Server uploaded</Text>
                            <Text style={{ color: C.t2, fontSize: 12, fontWeight: "700" }}>{fmtTime(meta.serverTime)}</Text>
                          </View>
                          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 10 }}>
                            <Text style={{ color: C.t3, fontSize: 12 }}>App last synced</Text>
                            <Text style={{ color: isUpToDate ? C.green : C.amber, fontSize: 12, fontWeight: "700" }}>{fmtTime(meta.appTime)}</Text>
                          </View>
                          <View style={{ backgroundColor: (isUpToDate ? C.green : C.amber) + "18", borderRadius: 8, padding: 8, alignItems: "center", borderWidth: 1, borderColor: (isUpToDate ? C.green : C.amber) + "44", marginBottom: 8 }}>
                            <Text style={{ color: isUpToDate ? C.green : C.amber, fontSize: 12, fontWeight: "900" }}>
                              {isUpToDate ? "✓ UP TO DATE" : neverSynced ? "⚠ NEVER SYNCED — tap to import" : "⚠ UPDATE AVAILABLE — tap to sync"}
                            </Text>
                          </View>
                          <Text style={{ color: C.t3, fontSize: 9, marginTop: 2 }}>file: {filename}</Text>
                          <Text style={{ color: C.t3, fontSize: 9 }}>serverTime: {meta.serverTime ? String(meta.serverTime) : "null"}</Text>
                          <Text style={{ color: meta.appTime ? C.green : C.red, fontSize: 9 }}>appTime: {meta.appTime ? String(meta.appTime) : "null — never synced"}</Text>
                        </View>
                      )}
                    </View>
                  );
                })}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* Server fetching spinner */}
      <Modal visible={serverFetching} transparent animationType="fade">
        <View style={{ flex: 1, backgroundColor: "#00000088", alignItems: "center", justifyContent: "center" }}>
          <View style={{ backgroundColor: C.s2, borderRadius: 20, padding: 32, alignItems: "center", borderWidth: 1, borderColor: C.b1 }}>
            <MaterialCommunityIcons name="server-network" size={40} color={C.green} style={{ marginBottom: 14 }} />
            <Text style={{ color: C.t1, fontWeight: "800", fontSize: 17 }}>Connecting to server...</Text>
          </View>
        </View>
      </Modal>

      {/* Identity setup — first launch */}
      <IdentitySetupModal
        visible={showIdentitySetup}
        onSave={(identity) => {
          setUserIdentity(identity);
          setShowIdentitySetup(false);
          if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ type:"identify", ...identity }));
        }}
      />

      {/* Board session modal */}
      <BoardSessionModal
        visible={showSessionModal}
        onClose={() => setShowSessionModal(false)}
        userIdentity={userIdentity}
        wsRef={wsRef}
        currentRoomId={currentRoomId}
        setCurrentRoomId={setCurrentRoomId}
        setRoomName={setRoomName}
        setRoomMembers={setRoomMembers}
        focusList={kiaFocusList}
        pinnedIds={kiaPinnedIds}
        setFocusList={setKiaFocusList}
        setPinnedIds={setKiaPinnedIds}
        setKiaInvoices={setKiaInvoices}
        kiaInvoices={kiaInvoices}
        setIsRoomHost={setIsRoomHost}
      />

      {/* ── Export Filter Modal ── */}
      <Modal visible={exportFilterVisible} transparent animationType="slide" onRequestClose={() => setExportFilterVisible(false)}>
        <TouchableOpacity style={{ flex: 1, backgroundColor: "#00000088" }} activeOpacity={1} onPress={() => setExportFilterVisible(false)} />
        <View style={{ backgroundColor: C.s1, borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: "hidden" }}>
          {(() => {
            const pendingCutoff = new Date(); pendingCutoff.setHours(0,0,0,0);
            const isOnBoard = inv => !inv.removedFromBoard && (inv.manuallyAdded || inv.complete || (inv.parts && inv.parts.some(p => p.confirmed > 0)));
            const boardInvoices = kiaInvoices.filter(isOnBoard);
            let missingCount = 0, notScannedCount = 0, shortCount = 0, affectedInvoices = new Set();
            boardInvoices.forEach(inv => {
              (inv.parts || []).forEach(p => {
                const isMissing     = !!p.short && Number(p.shortQty) === 0;
                const isShort       = !!p.short && Number(p.shortQty) > 0;
                const isNotScanned  = !p.short && Number(p.confirmed) === 0;
                if (isMissing)    { missingCount++;    affectedInvoices.add(inv.id); }
                if (isShort)      { shortCount++;      affectedInvoices.add(inv.id); }
                if (isNotScanned) { notScannedCount++; affectedInvoices.add(inv.id); }
              });
            });
            const hasProblems = missingCount + notScannedCount + shortCount > 0;
            return (
              <>
                <View style={{ padding: 18, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: C.b1 }}>
                  <Text style={{ color: C.t1, fontSize: 17, fontWeight: "900" }}>Problems Report</Text>
                  <Text style={{ color: C.t3, fontSize: 12, marginTop: 2 }}>Focus Board only</Text>
                </View>
                <View style={{ padding: 14, paddingHorizontal: 18, gap: 8 }}>
                  <View style={{ backgroundColor: C.s2, borderRadius: 10, padding: 12, paddingHorizontal: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: C.red }} />
                      <Text style={{ color: C.t1, fontSize: 13, fontWeight: "700" }}>Marked missing</Text>
                    </View>
                    <Text style={{ color: C.red, fontSize: 14, fontWeight: "900" }}>{missingCount} part{missingCount !== 1 ? "s" : ""}</Text>
                  </View>
                  <View style={{ backgroundColor: C.s2, borderRadius: 10, padding: 12, paddingHorizontal: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: C.t3 }} />
                      <Text style={{ color: C.t1, fontSize: 13, fontWeight: "700" }}>Not scanned</Text>
                    </View>
                    <Text style={{ color: C.t2, fontSize: 14, fontWeight: "900" }}>{notScannedCount} part{notScannedCount !== 1 ? "s" : ""}</Text>
                  </View>
                  <View style={{ backgroundColor: C.s2, borderRadius: 10, padding: 12, paddingHorizontal: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: C.amber }} />
                      <Text style={{ color: C.t1, fontSize: 13, fontWeight: "700" }}>Short supply</Text>
                    </View>
                    <Text style={{ color: C.amber, fontSize: 14, fontWeight: "900" }}>{shortCount} part{shortCount !== 1 ? "s" : ""}</Text>
                  </View>
                  <View style={{ backgroundColor: C.s3, borderRadius: 10, padding: 10, paddingHorizontal: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderWidth: 1, borderColor: C.b1 }}>
                    <Text style={{ color: C.t3, fontSize: 12 }}>Across invoices</Text>
                    <Text style={{ color: C.t3, fontSize: 12, fontWeight: "700" }}>{affectedInvoices.size} invoice{affectedInvoices.size !== 1 ? "s" : ""}</Text>
                  </View>
                </View>
                <View style={{ flexDirection: "row", gap: 10, padding: 18, paddingBottom: 48, borderTopWidth: 1, borderTopColor: C.b1 }}>
                  <TouchableOpacity onPress={() => setExportFilterVisible(false)} activeOpacity={0.8}
                    style={{ flex: 1, backgroundColor: C.s3, borderRadius: 12, paddingVertical: 16, alignItems: "center", borderWidth: 1, borderColor: C.b1 }}>
                    <Text style={{ color: C.t2, fontSize: 14, fontWeight: "700" }}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    disabled={!hasProblems}
                    onPress={() => {
                      setExportFilterVisible(false);
                      const lines = ["Invoice ID,Order Ref,Part Number,Qty,Status,Short Qty Received"];
                      boardInvoices.forEach(inv => {
                        (inv.parts || []).forEach(p => {
                          if (!p || !p.partNumber) return;
                          const isMissing    = !!p.short && Number(p.shortQty) === 0;
                          const isShort      = !!p.short && Number(p.shortQty) > 0;
                          const isNotScanned = !p.short && Number(p.confirmed) === 0;
                          if (!isMissing && !isShort && !isNotScanned) return;
                          const status = isMissing ? "Missing" : isShort ? "Short Supply" : "Not Scanned";
                          const shortReceived = isShort ? Number(p.shortQty) : "";
                          lines.push(`${inv.id},${inv.orderRef || ""},${p.partNumber},${Number(p.qty) || 1},${status},${shortReceived}`);
                        });
                      });
                      const csv = lines.join("\n");
                      Share.share({
                        title: "Problems Report — " + new Date().toLocaleDateString(),
                        message: csv,
                      }).catch(e => console.error("Share error:", e));
                    }}
                    activeOpacity={0.85}
                    style={{ flex: 2, backgroundColor: hasProblems ? C.green : C.s3, borderRadius: 12, paddingVertical: 16, alignItems: "center" }}>
                    <Text style={{ color: hasProblems ? C.bg : C.t3, fontSize: 14, fontWeight: "900" }}>Send Report</Text>
                  </TouchableOpacity>
                </View>
              </>
            );
          })()}
        </View>
      </Modal>

    </SafeAreaProvider>
  );
}
