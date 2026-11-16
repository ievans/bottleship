# Whole-string text extent cache evidence

Source under test: 5801ec884fe08961e7458d79945551bfe3aca880. Headless Chrome 157 on macOS; canvas microbenchmark only, no guest/game performance claim.

The recorded compiled bench.js, index.html and raw results.json reproduce the original paired workload. checksums.json records the original benchmark source, bundle and results. The import in bench.ts has been normalized to a checkout-relative path for reproduction; all other source is unchanged. Run this source from a checkout of the source under test using `bun build validation/text-extent-cache/bench.ts --target browser --outfile validation/text-extent-cache/bench.js`, then serve the directory and open index.html in Chrome. Alternatively the recorded compiled bundle runs directly as a module with file access enabled. Use a separate browser profile for comparison.

Each of 12 balanced pairs measures 100,000 requests over 64 strings and four fonts, with fresh contexts/cache per arm. Each arm independently verifies its consumed count and checksum against direct native canvas results. Baseline uses the previous direct measurement/rounding behavior. Raw rows retain time, number of canvas calls and correctness totals. The benchmark is evidence for repeated canvas measurements; it does not satisfy an in-game workload performance claim.
