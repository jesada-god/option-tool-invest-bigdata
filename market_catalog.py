"""Offline reference catalog for Quantora AI search and category screens.

This module intentionally contains no market-data client, cache, or network call.
It is a curated lookup aid for ticker discovery only; prices, company facts, and
market availability must still come from the configured market-data provider.
"""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher
import re
import unicodedata
from typing import Iterable


DEFAULT_SEARCH_LIMIT = 12
MAX_SEARCH_LIMIT = 50
MAX_QUERY_LENGTH = 120


# Keep this order aligned with the product's category navigation rather than
# sorting it alphabetically.  Categories not represented by an instrument are
# deliberately not exposed by ``list_categories``.
CATEGORY_ORDER: tuple[str, ...] = (
    "Technology",
    "AI",
    "Semiconductor",
    "Software",
    "Healthcare",
    "Biotech",
    "Pharma",
    "Bank",
    "Insurance",
    "ETF",
    "Index",
    "Gold",
    "Silver",
    "Copper",
    "Lithium",
    "Uranium",
    "Oil",
    "Energy",
    "Crypto",
    "Space",
    "Defense",
    "EV",
    "Consumer",
    "Utilities",
    "Growth",
    "Dividend",
)


@dataclass(frozen=True, slots=True)
class MarketInstrument:
    """A safe, static search record.

    ``symbol`` is a display/reference symbol.  A data provider can use a
    separate symbol-mapping layer when it requires a different identifier
    (for example an index prefix).
    """

    symbol: str
    name: str
    sector: str
    category: str
    exchange: str
    # The catalog is intentionally US-listed.  This describes the listing
    # country, rather than attempting to infer an issuer's legal domicile.
    country: str = "United States"

    def as_dict(self) -> dict[str, str]:
        """Return an API-ready, JSON-serialisable representation."""

        return {
            "symbol": self.symbol,
            "name": self.name,
            "sector": self.sector,
            "category": self.category,
            "exchange": self.exchange,
            "country": self.country,
        }


def _record(
    symbol: str,
    name: str,
    sector: str,
    category: str,
    exchange: str,
    country: str = "United States",
) -> MarketInstrument:
    return MarketInstrument(symbol, name, sector, category, exchange, country)


# This is intentionally a reference catalog, not an exhaustive security
# master.  Each public V2 category has several well-known US-listed examples
# where practical, and symbols are unique so results are deterministic.
_CATALOG: tuple[MarketInstrument, ...] = (
    # Technology
    _record("AAPL", "Apple Inc.", "Information Technology", "Technology", "NASDAQ"),
    _record("MSFT", "Microsoft Corporation", "Information Technology", "Technology", "NASDAQ"),
    _record("GOOGL", "Alphabet Inc. Class A", "Communication Services", "Technology", "NASDAQ"),
    _record("META", "Meta Platforms Inc.", "Communication Services", "Technology", "NASDAQ"),
    _record("CSCO", "Cisco Systems Inc.", "Information Technology", "Technology", "NASDAQ"),
    _record("IBM", "International Business Machines", "Information Technology", "Technology", "NYSE"),
    _record("DELL", "Dell Technologies Inc.", "Information Technology", "Technology", "NYSE"),
    _record("HPQ", "HP Inc.", "Information Technology", "Technology", "NYSE"),
    # AI
    _record("PLTR", "Palantir Technologies Inc.", "Information Technology", "AI", "NASDAQ"),
    _record("AI", "C3.ai Inc.", "Information Technology", "AI", "NYSE"),
    _record("SOUN", "SoundHound AI Inc.", "Information Technology", "AI", "NASDAQ"),
    _record("PATH", "UiPath Inc.", "Information Technology", "AI", "NYSE"),
    _record("BBAI", "BigBear.ai Holdings Inc.", "Information Technology", "AI", "NYSE"),
    _record("UPST", "Upstart Holdings Inc.", "Financial Technology", "AI", "NASDAQ"),
    # Semiconductor
    _record("NVDA", "NVIDIA Corporation", "Information Technology", "Semiconductor", "NASDAQ"),
    _record("NVTS", "Navitas Semiconductor Corporation", "Information Technology", "Semiconductor", "NASDAQ"),
    _record("AMD", "Advanced Micro Devices Inc.", "Information Technology", "Semiconductor", "NASDAQ"),
    _record("TSM", "Taiwan Semiconductor Manufacturing ADR", "Information Technology", "Semiconductor", "NYSE"),
    _record("AVGO", "Broadcom Inc.", "Information Technology", "Semiconductor", "NASDAQ"),
    _record("ARM", "Arm Holdings plc ADR", "Information Technology", "Semiconductor", "NASDAQ"),
    _record("MU", "Micron Technology Inc.", "Information Technology", "Semiconductor", "NASDAQ"),
    _record("QCOM", "QUALCOMM Incorporated", "Information Technology", "Semiconductor", "NASDAQ"),
    _record("INTC", "Intel Corporation", "Information Technology", "Semiconductor", "NASDAQ"),
    _record("ASML", "ASML Holding N.V. ADR", "Information Technology", "Semiconductor", "NASDAQ"),
    _record("LRCX", "Lam Research Corporation", "Information Technology", "Semiconductor", "NASDAQ"),
    _record("AMAT", "Applied Materials Inc.", "Information Technology", "Semiconductor", "NASDAQ"),
    _record("KLAC", "KLA Corporation", "Information Technology", "Semiconductor", "NASDAQ"),
    _record("SMCI", "Super Micro Computer Inc.", "Information Technology", "Semiconductor", "NASDAQ"),
    _record("MRVL", "Marvell Technology Inc.", "Information Technology", "Semiconductor", "NASDAQ"),
    _record("ON", "ON Semiconductor Corporation", "Information Technology", "Semiconductor", "NASDAQ"),
    _record("NXPI", "NXP Semiconductors N.V.", "Information Technology", "Semiconductor", "NASDAQ"),
    _record("TXN", "Texas Instruments Incorporated", "Information Technology", "Semiconductor", "NASDAQ"),
    # Software
    _record("CRM", "Salesforce Inc.", "Information Technology", "Software", "NYSE"),
    _record("ORCL", "Oracle Corporation", "Information Technology", "Software", "NYSE"),
    _record("ADBE", "Adobe Inc.", "Information Technology", "Software", "NASDAQ"),
    _record("NOW", "ServiceNow Inc.", "Information Technology", "Software", "NYSE"),
    _record("INTU", "Intuit Inc.", "Information Technology", "Software", "NASDAQ"),
    _record("PANW", "Palo Alto Networks Inc.", "Information Technology", "Software", "NASDAQ"),
    _record("CRWD", "CrowdStrike Holdings Inc.", "Information Technology", "Software", "NASDAQ"),
    _record("FTNT", "Fortinet Inc.", "Information Technology", "Software", "NASDAQ"),
    _record("NET", "Cloudflare Inc.", "Information Technology", "Software", "NYSE"),
    _record("MDB", "MongoDB Inc.", "Information Technology", "Software", "NASDAQ"),
    _record("TEAM", "Atlassian Corporation", "Information Technology", "Software", "NASDAQ"),
    _record("SHOP", "Shopify Inc.", "Information Technology", "Software", "NASDAQ"),
    # Healthcare
    _record("UNH", "UnitedHealth Group Incorporated", "Healthcare", "Healthcare", "NYSE"),
    _record("JNJ", "Johnson & Johnson", "Healthcare", "Healthcare", "NYSE"),
    _record("ABT", "Abbott Laboratories", "Healthcare", "Healthcare", "NYSE"),
    _record("ISRG", "Intuitive Surgical Inc.", "Healthcare", "Healthcare", "NASDAQ"),
    _record("TMO", "Thermo Fisher Scientific Inc.", "Healthcare", "Healthcare", "NYSE"),
    _record("DHR", "Danaher Corporation", "Healthcare", "Healthcare", "NYSE"),
    _record("CVS", "CVS Health Corporation", "Healthcare", "Healthcare", "NYSE"),
    # Biotech
    _record("AMGN", "Amgen Inc.", "Healthcare", "Biotech", "NASDAQ"),
    _record("GILD", "Gilead Sciences Inc.", "Healthcare", "Biotech", "NASDAQ"),
    _record("REGN", "Regeneron Pharmaceuticals Inc.", "Healthcare", "Biotech", "NASDAQ"),
    _record("VRTX", "Vertex Pharmaceuticals Incorporated", "Healthcare", "Biotech", "NASDAQ"),
    _record("BIIB", "Biogen Inc.", "Healthcare", "Biotech", "NASDAQ"),
    _record("MRNA", "Moderna Inc.", "Healthcare", "Biotech", "NASDAQ"),
    _record("NVAX", "Novavax Inc.", "Healthcare", "Biotech", "NASDAQ"),
    _record("ILMN", "Illumina Inc.", "Healthcare", "Biotech", "NASDAQ"),
    _record("CRSP", "CRISPR Therapeutics AG", "Healthcare", "Biotech", "NASDAQ"),
    # Pharma
    _record("LLY", "Eli Lilly and Company", "Healthcare", "Pharma", "NYSE"),
    _record("NVO", "Novo Nordisk A/S ADR", "Healthcare", "Pharma", "NYSE"),
    _record("PFE", "Pfizer Inc.", "Healthcare", "Pharma", "NYSE"),
    _record("MRK", "Merck & Co. Inc.", "Healthcare", "Pharma", "NYSE"),
    _record("BMY", "Bristol-Myers Squibb Company", "Healthcare", "Pharma", "NYSE"),
    _record("ABBV", "AbbVie Inc.", "Healthcare", "Pharma", "NYSE"),
    _record("AZN", "AstraZeneca PLC ADR", "Healthcare", "Pharma", "NASDAQ"),
    # Bank
    _record("JPM", "JPMorgan Chase & Co.", "Financials", "Bank", "NYSE"),
    _record("BAC", "Bank of America Corporation", "Financials", "Bank", "NYSE"),
    _record("WFC", "Wells Fargo & Company", "Financials", "Bank", "NYSE"),
    _record("C", "Citigroup Inc.", "Financials", "Bank", "NYSE"),
    _record("GS", "Goldman Sachs Group Inc.", "Financials", "Bank", "NYSE"),
    _record("MS", "Morgan Stanley", "Financials", "Bank", "NYSE"),
    _record("SCHW", "Charles Schwab Corporation", "Financials", "Bank", "NYSE"),
    _record("USB", "U.S. Bancorp", "Financials", "Bank", "NYSE"),
    _record("PNC", "PNC Financial Services Group Inc.", "Financials", "Bank", "NYSE"),
    # Insurance
    _record("BRK.B", "Berkshire Hathaway Inc. Class B", "Financials", "Insurance", "NYSE"),
    _record("PGR", "Progressive Corporation", "Financials", "Insurance", "NYSE"),
    _record("ALL", "Allstate Corporation", "Financials", "Insurance", "NYSE"),
    _record("TRV", "Travelers Companies Inc.", "Financials", "Insurance", "NYSE"),
    _record("AIG", "American International Group Inc.", "Financials", "Insurance", "NYSE"),
    _record("CB", "Chubb Limited", "Financials", "Insurance", "NYSE"),
    _record("AFL", "Aflac Incorporated", "Financials", "Insurance", "NYSE"),
    _record("PRU", "Prudential Financial Inc.", "Financials", "Insurance", "NYSE"),
    # Broad and sector ETFs
    _record("SPY", "SPDR S&P 500 ETF Trust", "Exchange Traded Fund", "ETF", "NYSE Arca"),
    _record("QQQ", "Invesco QQQ Trust", "Exchange Traded Fund", "ETF", "NASDAQ"),
    _record("VTI", "Vanguard Total Stock Market ETF", "Exchange Traded Fund", "ETF", "NYSE Arca"),
    _record("IVV", "iShares Core S&P 500 ETF", "Exchange Traded Fund", "ETF", "NYSE Arca"),
    _record("VOO", "Vanguard S&P 500 ETF", "Exchange Traded Fund", "ETF", "NYSE Arca"),
    _record("IWM", "iShares Russell 2000 ETF", "Exchange Traded Fund", "ETF", "NYSE Arca"),
    _record("DIA", "SPDR Dow Jones Industrial Average ETF", "Exchange Traded Fund", "ETF", "NYSE Arca"),
    _record("XLK", "Technology Select Sector SPDR Fund", "Exchange Traded Fund", "ETF", "NYSE Arca"),
    _record("XLF", "Financial Select Sector SPDR Fund", "Exchange Traded Fund", "ETF", "NYSE Arca"),
    _record("XLV", "Health Care Select Sector SPDR Fund", "Exchange Traded Fund", "ETF", "NYSE Arca"),
    _record("XLE", "Energy Select Sector SPDR Fund", "Exchange Traded Fund", "ETF", "NYSE Arca"),
    _record("SMH", "VanEck Semiconductor ETF", "Exchange Traded Fund", "ETF", "NASDAQ"),
    _record("SOXX", "iShares Semiconductor ETF", "Exchange Traded Fund", "ETF", "NASDAQ"),
    _record("ARKK", "ARK Innovation ETF", "Exchange Traded Fund", "ETF", "NYSE Arca"),
    _record("TLT", "iShares 20+ Year Treasury Bond ETF", "Exchange Traded Fund", "ETF", "NASDAQ"),
    _record("HYG", "iShares iBoxx High Yield Corporate Bond ETF", "Exchange Traded Fund", "ETF", "NYSE Arca"),
    # Index references.  Provider adapters may map these to provider-specific symbols.
    _record("SPX", "S&P 500 Index", "Index", "Index", "S&P Dow Jones Indices"),
    _record("NDX", "Nasdaq-100 Index", "Index", "Index", "NASDAQ"),
    _record("DJI", "Dow Jones Industrial Average", "Index", "Index", "S&P Dow Jones Indices"),
    _record("RUT", "Russell 2000 Index", "Index", "Index", "FTSE Russell"),
    _record("VIX", "CBOE Volatility Index", "Index", "Index", "Cboe"),
    # Precious and industrial metals
    _record("GLD", "SPDR Gold Shares", "Materials", "Gold", "NYSE Arca"),
    _record("IAU", "iShares Gold Trust", "Materials", "Gold", "NYSE Arca"),
    _record("GDX", "VanEck Gold Miners ETF", "Materials", "Gold", "NYSE Arca"),
    _record("GOLD", "Barrick Gold Corporation", "Materials", "Gold", "NYSE"),
    _record("NEM", "Newmont Corporation", "Materials", "Gold", "NYSE"),
    _record("AEM", "Agnico Eagle Mines Limited", "Materials", "Gold", "NYSE"),
    _record("SLV", "iShares Silver Trust", "Materials", "Silver", "NYSE Arca"),
    _record("SIVR", "abrdn Physical Silver Shares ETF", "Materials", "Silver", "NYSE Arca"),
    _record("SIL", "Global X Silver Miners ETF", "Materials", "Silver", "NYSE Arca"),
    _record("PAAS", "Pan American Silver Corporation", "Materials", "Silver", "NYSE"),
    _record("WPM", "Wheaton Precious Metals Corp.", "Materials", "Silver", "NYSE"),
    _record("CPER", "United States Copper Index Fund", "Materials", "Copper", "NYSE Arca"),
    _record("COPX", "Global X Copper Miners ETF", "Materials", "Copper", "NYSE Arca"),
    _record("FCX", "Freeport-McMoRan Inc.", "Materials", "Copper", "NYSE"),
    _record("SCCO", "Southern Copper Corporation", "Materials", "Copper", "NYSE"),
    _record("TECK", "Teck Resources Limited", "Materials", "Copper", "NYSE"),
    # Strategic materials
    _record("LIT", "Global X Lithium & Battery Tech ETF", "Materials", "Lithium", "NYSE Arca"),
    _record("ALB", "Albemarle Corporation", "Materials", "Lithium", "NYSE"),
    _record("SQM", "Sociedad Quimica y Minera de Chile ADR", "Materials", "Lithium", "NYSE"),
    _record("LAC", "Lithium Americas Corp.", "Materials", "Lithium", "NYSE"),
    _record("SGML", "Sigma Lithium Corporation", "Materials", "Lithium", "NASDAQ"),
    _record("URA", "Global X Uranium ETF", "Materials", "Uranium", "NYSE Arca"),
    _record("URNM", "Sprott Uranium Miners ETF", "Materials", "Uranium", "NYSE Arca"),
    _record("CCJ", "Cameco Corporation", "Materials", "Uranium", "NYSE"),
    _record("UEC", "Uranium Energy Corp.", "Materials", "Uranium", "NYSE American"),
    _record("DNN", "Denison Mines Corp.", "Materials", "Uranium", "NYSE American"),
    _record("LEU", "Centrus Energy Corp.", "Energy", "Uranium", "NYSE American"),
    # Oil and Energy
    _record("USO", "United States Oil Fund", "Energy", "Oil", "NYSE Arca"),
    _record("XOP", "SPDR S&P Oil & Gas Exploration & Production ETF", "Energy", "Oil", "NYSE Arca"),
    _record("OIH", "VanEck Oil Services ETF", "Energy", "Oil", "NYSE Arca"),
    _record("CVX", "Chevron Corporation", "Energy", "Oil", "NYSE"),
    _record("XOM", "Exxon Mobil Corporation", "Energy", "Oil", "NYSE"),
    _record("OXY", "Occidental Petroleum Corporation", "Energy", "Oil", "NYSE"),
    _record("COP", "ConocoPhillips", "Energy", "Oil", "NYSE"),
    _record("SLB", "Schlumberger Limited", "Energy", "Oil", "NYSE"),
    _record("ENPH", "Enphase Energy Inc.", "Energy", "Energy", "NASDAQ"),
    _record("FSLR", "First Solar Inc.", "Energy", "Energy", "NASDAQ"),
    _record("NEE", "NextEra Energy Inc.", "Utilities", "Energy", "NYSE"),
    # Crypto proxies (US-listed securities, not spot crypto assets)
    _record("IBIT", "iShares Bitcoin Trust ETF", "Digital Assets", "Crypto", "NASDAQ"),
    _record("FBTC", "Fidelity Wise Origin Bitcoin Fund", "Digital Assets", "Crypto", "Cboe BZX"),
    _record("ETHA", "iShares Ethereum Trust ETF", "Digital Assets", "Crypto", "NASDAQ"),
    _record("COIN", "Coinbase Global Inc.", "Digital Assets", "Crypto", "NASDAQ"),
    _record("MSTR", "Strategy Incorporated", "Digital Assets", "Crypto", "NASDAQ"),
    _record("MARA", "MARA Holdings Inc.", "Digital Assets", "Crypto", "NASDAQ"),
    _record("RIOT", "Riot Platforms Inc.", "Digital Assets", "Crypto", "NASDAQ"),
    _record("CLSK", "CleanSpark Inc.", "Digital Assets", "Crypto", "NASDAQ"),
    _record("BITO", "ProShares Bitcoin Strategy ETF", "Digital Assets", "Crypto", "NYSE Arca"),
    # Space and Defense
    _record("RKLB", "Rocket Lab USA Inc.", "Industrials", "Space", "NASDAQ"),
    _record("ASTS", "AST SpaceMobile Inc.", "Communication Services", "Space", "NASDAQ"),
    _record("LUNR", "Intuitive Machines Inc.", "Industrials", "Space", "NASDAQ"),
    _record("RDW", "Redwire Corporation", "Industrials", "Space", "NYSE"),
    _record("SPCE", "Virgin Galactic Holdings Inc.", "Industrials", "Space", "NYSE"),
    _record("LMT", "Lockheed Martin Corporation", "Industrials", "Defense", "NYSE"),
    _record("RTX", "RTX Corporation", "Industrials", "Defense", "NYSE"),
    _record("NOC", "Northrop Grumman Corporation", "Industrials", "Defense", "NYSE"),
    _record("GD", "General Dynamics Corporation", "Industrials", "Defense", "NYSE"),
    _record("BA", "Boeing Company", "Industrials", "Defense", "NYSE"),
    _record("LHX", "L3Harris Technologies Inc.", "Industrials", "Defense", "NYSE"),
    _record("HII", "Huntington Ingalls Industries Inc.", "Industrials", "Defense", "NYSE"),
    _record("AVAV", "AeroVironment Inc.", "Industrials", "Defense", "NASDAQ"),
    # Electric vehicles
    _record("TSLA", "Tesla Inc.", "Consumer Discretionary", "EV", "NASDAQ"),
    _record("RIVN", "Rivian Automotive Inc.", "Consumer Discretionary", "EV", "NASDAQ"),
    _record("LCID", "Lucid Group Inc.", "Consumer Discretionary", "EV", "NASDAQ"),
    _record("NIO", "NIO Inc. ADR", "Consumer Discretionary", "EV", "NYSE"),
    _record("XPEV", "XPeng Inc. ADR", "Consumer Discretionary", "EV", "NYSE"),
    _record("LI", "Li Auto Inc. ADR", "Consumer Discretionary", "EV", "NASDAQ"),
    _record("GM", "General Motors Company", "Consumer Discretionary", "EV", "NYSE"),
    _record("F", "Ford Motor Company", "Consumer Discretionary", "EV", "NYSE"),
    _record("CHPT", "ChargePoint Holdings Inc.", "Consumer Discretionary", "EV", "NYSE"),
    # Consumer and Utilities
    _record("AMZN", "Amazon.com Inc.", "Consumer Discretionary", "Consumer", "NASDAQ"),
    _record("WMT", "Walmart Inc.", "Consumer Staples", "Consumer", "NYSE"),
    _record("COST", "Costco Wholesale Corporation", "Consumer Staples", "Consumer", "NASDAQ"),
    _record("HD", "Home Depot Inc.", "Consumer Discretionary", "Consumer", "NYSE"),
    _record("MCD", "McDonald's Corporation", "Consumer Discretionary", "Consumer", "NYSE"),
    _record("SBUX", "Starbucks Corporation", "Consumer Discretionary", "Consumer", "NASDAQ"),
    _record("NKE", "NIKE Inc. Class B", "Consumer Discretionary", "Consumer", "NYSE"),
    _record("LULU", "lululemon athletica inc.", "Consumer Discretionary", "Consumer", "NASDAQ"),
    _record("TGT", "Target Corporation", "Consumer Staples", "Consumer", "NYSE"),
    _record("KO", "Coca-Cola Company", "Consumer Staples", "Consumer", "NYSE"),
    _record("PEP", "PepsiCo Inc.", "Consumer Staples", "Consumer", "NASDAQ"),
    _record("PG", "Procter & Gamble Company", "Consumer Staples", "Consumer", "NYSE"),
    _record("DIS", "Walt Disney Company", "Communication Services", "Consumer", "NYSE"),
    _record("XLU", "Utilities Select Sector SPDR Fund", "Utilities", "Utilities", "NYSE Arca"),
    _record("DUK", "Duke Energy Corporation", "Utilities", "Utilities", "NYSE"),
    _record("SO", "Southern Company", "Utilities", "Utilities", "NYSE"),
    _record("AEP", "American Electric Power Company Inc.", "Utilities", "Utilities", "NASDAQ"),
    _record("EXC", "Exelon Corporation", "Utilities", "Utilities", "NASDAQ"),
    _record("SRE", "Sempra", "Utilities", "Utilities", "NYSE"),
    # Growth and income ETFs
    _record("VUG", "Vanguard Growth ETF", "Exchange Traded Fund", "Growth", "NYSE Arca"),
    _record("SCHG", "Schwab U.S. Large-Cap Growth ETF", "Exchange Traded Fund", "Growth", "NYSE Arca"),
    _record("IWF", "iShares Russell 1000 Growth ETF", "Exchange Traded Fund", "Growth", "NYSE Arca"),
    _record("MGK", "Vanguard Mega Cap Growth ETF", "Exchange Traded Fund", "Growth", "NYSE Arca"),
    _record("QQQM", "Invesco NASDAQ 100 ETF", "Exchange Traded Fund", "Growth", "NASDAQ"),
    _record("SCHD", "Schwab U.S. Dividend Equity ETF", "Exchange Traded Fund", "Dividend", "NYSE Arca"),
    _record("VYM", "Vanguard High Dividend Yield ETF", "Exchange Traded Fund", "Dividend", "NYSE Arca"),
    _record("DGRO", "iShares Core Dividend Growth ETF", "Exchange Traded Fund", "Dividend", "NYSE Arca"),
    _record("HDV", "iShares Core High Dividend ETF", "Exchange Traded Fund", "Dividend", "NYSE Arca"),
    _record("JEPI", "JPMorgan Equity Premium Income ETF", "Exchange Traded Fund", "Dividend", "NYSE Arca"),
    _record("JEPQ", "JPMorgan Nasdaq Equity Premium Income ETF", "Exchange Traded Fund", "Dividend", "NASDAQ"),
    _record("DVY", "iShares Select Dividend ETF", "Exchange Traded Fund", "Dividend", "NASDAQ"),
)


def _normalise_phrase(value: str) -> str:
    """Case-fold and collapse punctuation/spacing for safe comparisons."""

    folded = unicodedata.normalize("NFKD", value).casefold()
    return " ".join(re.sub(r"[^\w]+", " ", folded, flags=re.UNICODE).split())


def _normalise_compact(value: str) -> str:
    return "".join(character for character in _normalise_phrase(value) if character.isalnum())


def _validate_catalog(records: Iterable[MarketInstrument]) -> tuple[MarketInstrument, ...]:
    validated = tuple(records)
    symbols: set[str] = set()
    categories = set(CATEGORY_ORDER)
    for instrument in validated:
        if not all(
            isinstance(value, str) and value.strip()
            for value in (
                instrument.symbol,
                instrument.name,
                instrument.sector,
                instrument.category,
                instrument.exchange,
                instrument.country,
            )
        ):
            raise ValueError("Market catalog records require non-empty string fields")
        if not re.fullmatch(r"[A-Z0-9.\-]{1,16}", instrument.symbol):
            raise ValueError(f"Unsupported reference symbol: {instrument.symbol!r}")
        if instrument.symbol in symbols:
            raise ValueError(f"Duplicate market catalog symbol: {instrument.symbol}")
        if instrument.category not in categories:
            raise ValueError(f"Unknown market catalog category: {instrument.category}")
        symbols.add(instrument.symbol)
    return validated


MARKET_CATALOG: tuple[MarketInstrument, ...] = _validate_catalog(_CATALOG)
_BY_SYMBOL = {instrument.symbol: instrument for instrument in MARKET_CATALOG}
_CATALOG_POSITION = {
    instrument.symbol: position for position, instrument in enumerate(MARKET_CATALOG)
}
_CATEGORY_BY_NORMALISED_NAME = {
    _normalise_phrase(category): category for category in CATEGORY_ORDER
}
_CATEGORY_BY_NORMALISED_NAME.update(
    {
        "etfs": "ETF",
        "cryptocurrency": "Crypto",
        "crypto proxy": "Crypto",
        "crypto proxies": "Crypto",
        "indices": "Index",
    }
)

# Search aliases are deliberately explicit and point only to catalog symbols.
# They cover common legacy tickers and familiar company/index names without
# turning the reference catalog into an unbounded symbol master.
_TICKER_ALIASES: dict[str, tuple[str, ...]] = {
    "goog": ("GOOGL",),
    "fb": ("META",),
    "brk b": ("BRK.B",),
    "sp500": ("SPY",),
    "s p 500": ("SPY",),
    "nasdaq100": ("QQQ",),
    "nasdaq 100": ("QQQ",),
    "russell2000": ("IWM",),
    "russell 2000": ("IWM",),
    "dow": ("DIA",),
}
_COMPANY_ALIASES: dict[str, tuple[str, ...]] = {
    "google": ("GOOGL",),
    "facebook": ("META",),
    "berkshire": ("BRK.B",),
    "amazon": ("AMZN",),
    "netflix": ("NFLX",),
    "nvidia": ("NVDA",),
    "tesla": ("TSLA",),
    "apple": ("AAPL",),
    "microsoft": ("MSFT",),
    "coca cola": ("KO",),
}
_COUNTRY_ALIASES = {
    "us": "united states",
    "usa": "united states",
    "u s": "united states",
    "america": "united states",
}
_DIRECTORY_FILTER_KEYS = frozenset({"sector", "industry", "country", "exchange"})
# The catalog intentionally has no price/fundamental values. These keys are
# still parsed so a search client can offer complete query autocomplete without
# misrepresenting stale or invented values as provider-backed facts.
_NUMERIC_FILTER_KEYS = frozenset({"marketcap", "price", "pe", "dividend"})
_FILTER_KEYS = _DIRECTORY_FILTER_KEYS | _NUMERIC_FILTER_KEYS


def _safe_limit(limit: object, *, default: int) -> int:
    """Clamp externally supplied result sizes without raising on bad input."""

    if limit is None:
        return default
    if isinstance(limit, bool):
        return default
    try:
        parsed = int(limit)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError):
        return default
    return max(0, min(parsed, MAX_SEARCH_LIMIT))


def _parse_search_query(query: str) -> tuple[str, dict[str, str]]:
    """Split explicit filters and common natural-language search phrases."""

    filters: dict[str, str] = {}
    free_terms: list[str] = []
    for token in re.findall(r'(?:[^\s"]|"[^"]*")+', query):
        key, separator, value = token.partition(":")
        normalized_key = key.casefold()
        if separator and normalized_key in _FILTER_KEYS and value:
            normalized_value = _normalise_phrase(value.strip('"'))
            if normalized_value:
                filters[normalized_key] = normalized_value
            continue
        free_terms.append(token)
    free_text = " ".join(free_terms)
    phrase = _normalise_phrase(free_text)
    natural_patterns = (
        (r"\bhigh dividend\b", "industry"),
        (r"\b(?:on|in)\s+(nasdaq|nyse|nyse arca)\b", "exchange"),
        (r"\b(?:us|usa|american)\s+(?:stocks?|companies?|etfs?)\b", "country"),
        (r"\b(semiconductor|biotech|pharma|insurance|defense|energy|utilities|dividend|growth)\s+(?:stocks?|companies?|etfs?)\b", "industry"),
        (r"\b(information technology|technology|healthcare|financials|consumer discretionary|consumer staples|materials)\s+(?:stocks?|companies?|etfs?)\b", "sector"),
    )
    for pattern, key in natural_patterns:
        match = re.search(pattern, phrase)
        if not match:
            continue
        value = "dividend" if pattern == r"\bhigh dividend\b" else match.group(1)
        filters.setdefault(key, value)
        phrase = f"{phrase[:match.start()]} {phrase[match.end():]}"
    # These words describe the search rather than an instrument.
    phrase = re.sub(r"\b(?:find|show|me|the|stocks?|companies?|etfs?)\b", " ", phrase)
    return _normalise_phrase(phrase), filters


def _matches_filters(instrument: MarketInstrument, filters: dict[str, str]) -> bool:
    sector = _normalise_phrase(instrument.sector)
    industry = _normalise_phrase(instrument.category)
    country = _normalise_phrase(instrument.country)
    exchange = _normalise_phrase(instrument.exchange)
    requested_sector = filters.get("sector")
    requested_industry = filters.get("industry")
    requested_country = filters.get("country")
    requested_exchange = filters.get("exchange")
    # Numeric filters require live provider fundamentals and are deliberately
    # not evaluated against this offline discovery catalog.
    if any(key in filters for key in _NUMERIC_FILTER_KEYS):
        return False
    if requested_sector and requested_sector not in sector:
        return False
    if requested_industry:
        canonical_industry = _CATEGORY_BY_NORMALISED_NAME.get(requested_industry, requested_industry)
        if canonical_industry != instrument.category and requested_industry not in industry:
            return False
    if requested_country:
        canonical_country = _COUNTRY_ALIASES.get(requested_country, requested_country)
        if canonical_country not in country:
            return False
    return not requested_exchange or requested_exchange in exchange


def _alias_rank(symbol: str, query_phrase: str) -> tuple[int, int] | None:
    """Return a stable alias tier, or ``None`` when no alias applies."""

    for aliases, exact_tier in ((_TICKER_ALIASES, 0), (_COMPANY_ALIASES, 1)):
        for alias, symbols in aliases.items():
            if symbol not in symbols:
                continue
            if query_phrase == alias:
                return (exact_tier, 0)
            if alias.startswith(query_phrase):
                return (exact_tier + 2, 0)
            if query_phrase in alias:
                return (exact_tier + 4, alias.index(query_phrase))
    return None


def get_instrument(symbol: object) -> MarketInstrument | None:
    """Look up one record by ticker, case-insensitively, without I/O."""

    if not isinstance(symbol, str):
        return None
    return _BY_SYMBOL.get(symbol.strip().upper())


def list_categories() -> tuple[str, ...]:
    """Return populated categories in product navigation order."""

    populated = {instrument.category for instrument in MARKET_CATALOG}
    return tuple(category for category in CATEGORY_ORDER if category in populated)


def list_instruments_by_category(category: object, limit: object = None) -> tuple[MarketInstrument, ...]:
    """Return a deterministic, symbol-sorted category slice.

    Unknown, blank, or non-string categories return an empty tuple.  The
    optional limit is clamped to ``MAX_SEARCH_LIMIT``.
    """

    if not isinstance(category, str):
        return ()
    canonical_category = _CATEGORY_BY_NORMALISED_NAME.get(_normalise_phrase(category))
    if canonical_category is None:
        return ()
    max_results = _safe_limit(limit, default=MAX_SEARCH_LIMIT)
    if max_results == 0:
        return ()
    matches = [
        instrument for instrument in MARKET_CATALOG if instrument.category == canonical_category
    ]
    return tuple(sorted(matches, key=lambda instrument: (instrument.symbol, instrument.name))[:max_results])


def _word_prefix_match(query_phrase: str, field_phrase: str) -> bool:
    return field_phrase.startswith(query_phrase) or any(
        word.startswith(query_phrase) for word in field_phrase.split()
    )


def _fuzzy_score(query_compact: str, instrument: MarketInstrument) -> float:
    """Return a deterministic typo-tolerance score across safe static fields."""

    aliases = tuple(
        _normalise_compact(alias)
        for alias_map in (_TICKER_ALIASES, _COMPANY_ALIASES)
        for alias, symbols in alias_map.items()
        if instrument.symbol in symbols
    )
    targets = (
        _normalise_compact(instrument.symbol),
        _normalise_compact(instrument.name),
        _normalise_compact(instrument.category),
        _normalise_compact(instrument.sector),
    ) + aliases
    return max(
        SequenceMatcher(None, query_compact, target, autojunk=False).ratio()
        for target in targets
    )


def _fuzzy_threshold(query_compact: str) -> float:
    # One- and two-character fuzzy matching creates noisy results.  Prefix and
    # contains matching still works for short queries.
    if len(query_compact) < 3:
        return 1.01
    if len(query_compact) == 3:
        return 0.80
    if len(query_compact) <= 5:
        return 0.72
    return 0.66


def search_instruments(
    query: object,
    limit: object = DEFAULT_SEARCH_LIMIT,
    *,
    include_fuzzy: bool = True,
) -> tuple[MarketInstrument, ...]:
    """Search the reference catalog with deterministic, offline ranking.

    Ranking is: exact ticker, exact name, ticker prefix, name-word prefix,
    ticker contains, name/category/sector contains, then fuzzy typo matches.
    The query accepts ``sector:``, ``industry:``, ``country:``, and
    ``exchange:`` filters, plus natural phrases such as "semiconductor stocks
    on NASDAQ". ``marketcap:``, ``price:``, ``pe:``, and ``dividend:`` are
    parsed but cannot be evaluated until provider-backed fundamentals are in
    the catalog. Common legacy tickers and company names resolve through the
    explicit alias map before fuzzy matching.
    Prefix matches use the curated catalog order as their relevance order; all
    other ties resolve by symbol and name.  The response is therefore stable
    for APIs, cache keys, and tests.
    """

    if not isinstance(query, str):
        return ()
    if len(query) > MAX_QUERY_LENGTH:
        return ()
    free_text, filters = _parse_search_query(query)
    query_phrase = _normalise_phrase(free_text)
    query_compact = _normalise_compact(free_text)
    max_results = _safe_limit(limit, default=DEFAULT_SEARCH_LIMIT)
    if max_results == 0 or (not filters and (not query_phrase or not query_compact)):
        return ()

    ranked: list[tuple[tuple[object, ...], MarketInstrument]] = []
    fuzzy_threshold = _fuzzy_threshold(query_compact)

    for instrument in MARKET_CATALOG:
        if not _matches_filters(instrument, filters):
            continue
        if not query_phrase or not query_compact:
            ranked.append(((7, 0, 0, instrument.symbol, instrument.name), instrument))
            continue
        symbol = _normalise_compact(instrument.symbol)
        name = _normalise_phrase(instrument.name)
        category = _normalise_phrase(instrument.category)
        sector = _normalise_phrase(instrument.sector)
        alias_rank = _alias_rank(instrument.symbol, query_phrase)

        if query_compact == symbol:
            rank: tuple[object, ...] = (0, 0, 0, instrument.symbol, instrument.name)
        elif query_phrase == name:
            rank = (1, 0, 0, instrument.symbol, instrument.name)
        # Exact legacy/company aliases should resolve before partial matches,
        # but a partial alias must not outrank a direct ticker prefix.
        elif alias_rank is not None and alias_rank[0] < 2:
            rank = (alias_rank[0], alias_rank[1], 0, instrument.symbol, instrument.name)
        elif symbol.startswith(query_compact):
            rank = (2, _CATALOG_POSITION[instrument.symbol], 0, instrument.symbol, instrument.name)
        elif _word_prefix_match(query_phrase, name):
            rank = (3, len(name), 0, instrument.symbol, instrument.name)
        elif alias_rank is not None:
            rank = (alias_rank[0], alias_rank[1], 0, instrument.symbol, instrument.name)
        elif query_compact in symbol:
            rank = (4, symbol.index(query_compact), len(symbol), instrument.symbol, instrument.name)
        elif query_phrase in name:
            rank = (5, 0, name.index(query_phrase), instrument.symbol, instrument.name)
        elif query_phrase in category:
            rank = (5, 1, category.index(query_phrase), instrument.symbol, instrument.name)
        elif query_phrase in sector:
            rank = (5, 2, sector.index(query_phrase), instrument.symbol, instrument.name)
        elif include_fuzzy:
            score = _fuzzy_score(query_compact, instrument)
            if score < fuzzy_threshold:
                continue
            rank = (6, -round(score, 8), instrument.symbol, instrument.name)
        else:
            continue
        ranked.append((rank, instrument))

    ranked.sort(key=lambda item: item[0])
    return tuple(instrument for _, instrument in ranked[:max_results])


__all__ = [
    "CATEGORY_ORDER",
    "DEFAULT_SEARCH_LIMIT",
    "MARKET_CATALOG",
    "MAX_QUERY_LENGTH",
    "MAX_SEARCH_LIMIT",
    "MarketInstrument",
    "get_instrument",
    "list_categories",
    "list_instruments_by_category",
    "search_instruments",
]
