#!/usr/bin/env python3
"""
Fetch BTC Above/Range markets from Polymarket and matching Deribit instruments.
Saves combined data to data.json.
"""

import json
import re
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

BASE_DIR = "/Users/molt/Desktop/PM-Deribit对冲套利研究"
RATE_LIMIT = 0.2  # seconds between requests

MONTH_MAP = {
    "January": "JAN", "February": "FEB", "March": "MAR", "April": "APR",
    "May": "MAY", "June": "JUN", "July": "JUL", "August": "AUG",
    "September": "SEP", "October": "OCT", "November": "NOV", "December": "DEC",
    "Jan": "JAN", "Feb": "FEB", "Mar": "MAR", "Apr": "APR",
    "Jun": "JUN", "Jul": "JUL", "Aug": "AUG",
    "Sep": "SEP", "Oct": "OCT", "Nov": "NOV", "Dec": "DEC",
}

MONTH_NUM = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}


def api_get(url, retries=3):
    """GET JSON from url with retries."""
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode())
        except Exception as e:
            if attempt < retries - 1:
                print(f"  Retry {attempt+1} for {url[:80]}... ({e})")
                time.sleep(1)
            else:
                print(f"  FAILED: {url[:80]} -> {e}")
                return None


def fetch_pm_markets():
    """Fetch all active BTC above/between markets from Polymarket Gamma API."""
    print("=== Step 1: Fetching Polymarket markets ===")
    all_markets = []
    for offset in range(0, 5000, 500):
        url = (
            f"https://gamma-api.polymarket.com/markets?"
            f"limit=500&active=true&closed=false"
            f"&order=volume24hr&ascending=false&offset={offset}"
        )
        print(f"  Fetching offset={offset}...")
        data = api_get(url)
        if data and isinstance(data, list):
            all_markets.extend(data)
            print(f"    Got {len(data)} markets")
            if len(data) < 500:
                break
        else:
            print(f"    No data or unexpected format")
            break
        time.sleep(RATE_LIMIT)

    # Filter for BTC above/between
    filtered = []
    for m in all_markets:
        q = (m.get("question") or "").lower()
        if "bitcoin" not in q and "btc" not in q:
            continue
        if "above" not in q and "between" not in q:
            continue
        filtered.append(m)

    print(f"  Total fetched: {len(all_markets)}, BTC above/between: {len(filtered)}")
    return filtered


def parse_above_market(question):
    """Parse 'Will Bitcoin be above $X on Month DD?' -> (strike, month_str, day)"""
    # Patterns like: "Will Bitcoin be above $74,000 on March 17?"
    m = re.search(r'above\s+\$?([\d,]+)', question, re.IGNORECASE)
    if not m:
        return None
    strike = int(m.group(1).replace(",", ""))

    # Date patterns
    date_m = re.search(r'on\s+(\w+)\s+(\d+)', question, re.IGNORECASE)
    if not date_m:
        # Try "March 17th" style
        date_m = re.search(r'(\w+)\s+(\d+)(?:st|nd|rd|th)?', question, re.IGNORECASE)
    if not date_m:
        return None

    month_word = date_m.group(1)
    day = int(date_m.group(2))
    month_abbr = MONTH_MAP.get(month_word)
    if not month_abbr:
        return None

    return {"strike": strike, "month": month_abbr, "day": day}


def parse_between_market(question):
    """Parse 'Will Bitcoin be between $X and $Y on Month DD?'"""
    m = re.search(r'between\s+\$?([\d,]+)\s+and\s+\$?([\d,]+)', question, re.IGNORECASE)
    if not m:
        return None
    k1 = int(m.group(1).replace(",", ""))
    k2 = int(m.group(2).replace(",", ""))

    date_m = re.search(r'on\s+(\w+)\s+(\d+)', question, re.IGNORECASE)
    if not date_m:
        return None
    month_word = date_m.group(1)
    day = int(date_m.group(2))
    month_abbr = MONTH_MAP.get(month_word)
    if not month_abbr:
        return None

    return {"strike_low": min(k1, k2), "strike_high": max(k1, k2),
            "month": month_abbr, "day": day}


def fetch_clob_book(token_id):
    """Fetch CLOB order book and return best bid/ask."""
    url = f"https://clob.polymarket.com/book?token_id={token_id}"
    data = api_get(url)
    if not data:
        return None, None

    best_ask = None
    best_bid = None
    asks = data.get("asks", [])
    bids = data.get("bids", [])
    if asks:
        best_ask = min(float(a["price"]) for a in asks)
    if bids:
        best_bid = max(float(b["price"]) for b in bids)
    return best_bid, best_ask


def deribit_instrument_name(month, day, year=26):
    """Build Deribit date prefix like '17MAR26'."""
    return f"{day}{month}{year}"


def fetch_deribit_ticker(instrument):
    """Fetch Deribit ticker for an instrument."""
    url = (
        f"https://www.deribit.com/api/v2/public/ticker?"
        f"instrument_name={instrument}"
    )
    data = api_get(url)
    if not data or "result" not in data:
        return None
    return data["result"]


def fetch_deribit_index():
    """Fetch BTC index price from Deribit."""
    url = "https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd"
    data = api_get(url)
    if data and "result" in data:
        return data["result"].get("index_price")
    return None


def process_markets(markets):
    """Process each market: fetch CLOB books and Deribit data."""
    print("\n=== Step 2 & 3: Fetching order books and Deribit data ===")

    # Get BTC index price once
    btc_price = fetch_deribit_index()
    print(f"  Deribit BTC index: ${btc_price}")
    time.sleep(RATE_LIMIT)

    results = []
    for i, m in enumerate(markets):
        question = m.get("question", "")
        print(f"\n[{i+1}/{len(markets)}] {question}")

        # Determine type and parse
        q_lower = question.lower()
        if "above" in q_lower:
            mtype = "Above"
            parsed = parse_above_market(question)
            if not parsed:
                print("  -> Could not parse, skipping")
                continue
            strike = parsed["strike"]
            month = parsed["month"]
            day = parsed["day"]
        elif "between" in q_lower:
            mtype = "Range"
            parsed = parse_between_market(question)
            if not parsed:
                print("  -> Could not parse, skipping")
                continue
            strike = [parsed["strike_low"], parsed["strike_high"]]
            month = parsed["month"]
            day = parsed["day"]
        else:
            continue

        # Parse clobTokenIds
        clob_ids_raw = m.get("clobTokenIds", "[]")
        try:
            clob_ids = json.loads(clob_ids_raw) if isinstance(clob_ids_raw, str) else clob_ids_raw
        except:
            clob_ids = []

        if len(clob_ids) < 2:
            print(f"  -> Not enough token IDs ({clob_ids}), skipping")
            continue

        yes_token = clob_ids[0]
        no_token = clob_ids[1]

        # Fetch PM CLOB books
        print(f"  Fetching Yes book ({yes_token[:12]}...)...")
        yes_bid, yes_ask = fetch_clob_book(yes_token)
        time.sleep(RATE_LIMIT)

        print(f"  Fetching No book ({no_token[:12]}...)...")
        no_bid, no_ask = fetch_clob_book(no_token)
        time.sleep(RATE_LIMIT)

        print(f"  PM Yes: bid={yes_bid} ask={yes_ask} | No: bid={no_bid} ask={no_ask}")

        # Build Deribit instrument names
        date_str = deribit_instrument_name(month, day)
        # e.g. "17MAR26"

        deribit_call_bid = None
        deribit_call_ask = None
        deribit_put_bid = None
        deribit_put_ask = None
        deribit_call_mark = None
        deribit_put_mark = None
        deribit_call_delta = None
        deribit_put_delta = None

        if mtype == "Above":
            # Fetch call and put for the strike
            call_inst = f"BTC-{date_str}-{strike}-C"
            put_inst = f"BTC-{date_str}-{strike}-P"

            print(f"  Fetching Deribit {call_inst}...")
            call_data = fetch_deribit_ticker(call_inst)
            time.sleep(RATE_LIMIT)

            print(f"  Fetching Deribit {put_inst}...")
            put_data = fetch_deribit_ticker(put_inst)
            time.sleep(RATE_LIMIT)

            if call_data:
                deribit_call_bid = call_data.get("best_bid_price")
                deribit_call_ask = call_data.get("best_ask_price")
                deribit_call_mark = call_data.get("mark_price")
                greeks = call_data.get("greeks", {})
                deribit_call_delta = greeks.get("delta") if greeks else None
            else:
                print(f"    {call_inst} not found")

            if put_data:
                deribit_put_bid = put_data.get("best_bid_price")
                deribit_put_ask = put_data.get("best_ask_price")
                deribit_put_mark = put_data.get("mark_price")
                greeks = put_data.get("greeks", {})
                deribit_put_delta = greeks.get("delta") if greeks else None
            else:
                print(f"    {put_inst} not found")

            deribit_inst_label = f"BTC-{date_str}-{strike}"
        else:
            # Range: fetch calls/puts for both strikes
            k1, k2 = strike
            call1_inst = f"BTC-{date_str}-{k1}-C"
            call2_inst = f"BTC-{date_str}-{k2}-C"

            print(f"  Fetching Deribit {call1_inst} and {call2_inst}...")
            call1_data = fetch_deribit_ticker(call1_inst)
            time.sleep(RATE_LIMIT)
            call2_data = fetch_deribit_ticker(call2_inst)
            time.sleep(RATE_LIMIT)

            deribit_call_bid = {}
            deribit_call_ask = {}
            deribit_call_mark = {}
            deribit_call_delta = {}

            for label, cdata, k in [(k1, call1_data, k1), (k2, call2_data, k2)]:
                if cdata:
                    deribit_call_bid[str(k)] = cdata.get("best_bid_price")
                    deribit_call_ask[str(k)] = cdata.get("best_ask_price")
                    deribit_call_mark[str(k)] = cdata.get("mark_price")
                    greeks = cdata.get("greeks", {})
                    deribit_call_delta[str(k)] = greeks.get("delta") if greeks else None
                else:
                    print(f"    {label} not found on Deribit")
                    deribit_call_bid[str(k)] = None
                    deribit_call_ask[str(k)] = None
                    deribit_call_mark[str(k)] = None
                    deribit_call_delta[str(k)] = None

            deribit_inst_label = f"BTC-{date_str}-{k1}/{k2}"
            # For range, put data is less relevant but let's skip for now
            deribit_put_bid = None
            deribit_put_ask = None
            deribit_put_mark = None
            deribit_put_delta = None

        # Compute time difference
        # PM settles at 12:00 ET (16:00 UTC), Deribit at 08:00 UTC
        # time_diff = 8 hours (PM is 8h after Deribit)
        time_diff_hours = 8

        # Date formatting
        month_num = MONTH_NUM.get(month, 1)
        pm_date_str = f"{month[:3].title()} {day}"
        pm_end = f"{month_num}/{day} 16:00 UTC"
        deribit_expiry = f"{month_num}/{day} 08:00 UTC"
        end_date = m.get("endDate", "")

        # Event slug
        slug = m.get("slug", "")
        # Sometimes slug is in events
        events = m.get("events", [])
        event_slug = ""
        if events and isinstance(events, list):
            event_slug = events[0].get("slug", "") if events else ""
        if not event_slug:
            event_slug = slug

        record = {
            "type": mtype,
            "question": question,
            "pm_date": pm_date_str,
            "strike": strike,
            "pm_end": pm_end,
            "pm_end_iso": end_date,
            "pm_yes_bid": yes_bid,
            "pm_yes_ask": yes_ask,
            "pm_no_bid": no_bid,
            "pm_no_ask": no_ask,
            "deribit_instrument": deribit_inst_label,
            "deribit_expiry": deribit_expiry,
            "deribit_call_bid": deribit_call_bid,
            "deribit_call_ask": deribit_call_ask,
            "deribit_call_mark": deribit_call_mark,
            "deribit_call_delta": deribit_call_delta,
            "deribit_put_bid": deribit_put_bid,
            "deribit_put_ask": deribit_put_ask,
            "deribit_put_mark": deribit_put_mark,
            "deribit_put_delta": deribit_put_delta,
            "deribit_underlying": btc_price,
            "time_diff_hours": time_diff_hours,
            "pm_event_slug": event_slug,
            "pm_yes_token": yes_token,
            "pm_no_token": no_token,
        }
        results.append(record)
        print(f"  -> OK")

    return results


def main():
    start = time.time()
    print(f"Starting data fetch at {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}\n")

    markets = fetch_pm_markets()
    if not markets:
        print("No markets found!")
        return

    results = process_markets(markets)

    # Sort by date then strike
    def sort_key(r):
        s = r["strike"]
        if isinstance(s, list):
            s = s[0]
        d = r.get("pm_date", "")
        return (d, s)

    results.sort(key=sort_key)

    output = {
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "btc_index": results[0]["deribit_underlying"] if results else None,
        "count": len(results),
        "markets": results,
    }

    out_path = f"{BASE_DIR}/data.json"
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    elapsed = time.time() - start
    print(f"\n=== Done! ===")
    print(f"  {len(results)} markets saved to {out_path}")
    print(f"  Elapsed: {elapsed:.1f}s")


if __name__ == "__main__":
    main()
