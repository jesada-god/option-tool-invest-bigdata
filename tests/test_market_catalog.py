import unittest

from market_catalog import (
    CATEGORY_ORDER,
    MARKET_CATALOG,
    MAX_SEARCH_LIMIT,
    get_instrument,
    list_categories,
    list_instruments_by_category,
    search_instruments,
)


class MarketCatalogTests(unittest.TestCase):
    def test_catalog_is_large_unique_and_has_all_v2_categories(self):
        self.assertGreaterEqual(len(MARKET_CATALOG), 50)
        self.assertEqual(len({item.symbol for item in MARKET_CATALOG}), len(MARKET_CATALOG))
        self.assertTrue(set(CATEGORY_ORDER).issubset(set(list_categories())))
        for instrument in MARKET_CATALOG:
            self.assertTrue(instrument.symbol)
            self.assertTrue(instrument.name)
            self.assertTrue(instrument.sector)
            self.assertTrue(instrument.category)
            self.assertTrue(instrument.exchange)

    def test_exact_and_case_insensitive_symbol_search(self):
        results = search_instruments("nvda")

        self.assertTrue(results)
        self.assertEqual(results[0].symbol, "NVDA")
        self.assertEqual(get_instrument("nVdA"), results[0])
        self.assertIsNone(get_instrument("not-a-symbol"))

    def test_prefix_and_contains_search_are_ranked_deterministically(self):
        prefix_results = search_instruments("nv", include_fuzzy=False)
        symbols = [item.symbol for item in prefix_results]
        self.assertIn("NVDA", symbols)
        self.assertIn("NVTS", symbols)
        self.assertIn("NVAX", symbols)
        self.assertIn("NVO", symbols)
        self.assertEqual(symbols[:4], ["NVDA", "NVTS", "NVAX", "NVO"])

        contains_results = search_instruments("crowd", include_fuzzy=False)
        self.assertEqual(contains_results[0].symbol, "CRWD")
        self.assertEqual(contains_results, search_instruments("crowd", include_fuzzy=False))

    def test_fuzzy_search_can_recover_common_typo_and_can_be_disabled(self):
        typo_results = search_instruments("nvida")
        self.assertEqual(typo_results[0].symbol, "NVDA")
        self.assertNotIn("NVDA", [item.symbol for item in search_instruments("nvida", include_fuzzy=False)])

    def test_aliases_and_advanced_filters_are_supported(self):
        self.assertEqual(search_instruments("GOOG")[0].symbol, "GOOGL")
        self.assertEqual(search_instruments("facebook")[0].symbol, "META")
        self.assertEqual(search_instruments("googel")[0].symbol, "GOOGL")

        filtered = search_instruments("sector:technology industry:semiconductor exchange:nasdaq country:us", limit=50)
        self.assertTrue(filtered)
        self.assertTrue(all(item.sector == "Information Technology" for item in filtered))
        self.assertTrue(all(item.category == "Semiconductor" for item in filtered))
        self.assertTrue(all(item.exchange == "NASDAQ" for item in filtered))
        self.assertTrue(all(item.country == "United States" for item in filtered))

    def test_natural_language_directory_search_and_unavailable_numeric_filters(self):
        natural_results = search_instruments("semiconductor stocks on nasdaq", limit=50)
        self.assertTrue(natural_results)
        self.assertTrue(all(item.category == "Semiconductor" and item.exchange == "NASDAQ" for item in natural_results))
        self.assertEqual(search_instruments("price:<100"), ())

    def test_category_listing_is_case_insensitive_and_bounded(self):
        semiconductors = list_instruments_by_category("semiconductor", limit=999)
        self.assertLessEqual(len(semiconductors), MAX_SEARCH_LIMIT)
        self.assertTrue(semiconductors)
        self.assertTrue(all(item.category == "Semiconductor" for item in semiconductors))
        self.assertEqual(
            semiconductors,
            tuple(sorted(semiconductors, key=lambda item: (item.symbol, item.name))),
        )
        self.assertTrue(list_instruments_by_category("ETFs"))
        self.assertEqual(list_instruments_by_category("unknown"), ())

    def test_bad_or_overlarge_inputs_are_safe(self):
        self.assertEqual(search_instruments(None), ())
        self.assertEqual(search_instruments(" "), ())
        self.assertEqual(search_instruments("a" * 121), ())
        self.assertEqual(search_instruments("nv", limit=0), ())
        self.assertLessEqual(len(search_instruments("a", limit=999)), MAX_SEARCH_LIMIT)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
