| Arm | Driver | Tier | Success | Strict | Wall p50 | Wall p90 | Tool calls | Obs KB | Turns | Tokens/solved | $/solved |
|---|---|---|---|---|---|---|---|---|---|---|---|
| oracle-local | local | all | 57/60 | 57/60 | 0.8 s | 1.9 s | 5.5 | 14.7 | n/a | n/a | n/a |
| oracle-local | local | public | 21/24 | 21/24 | 0.8 s | 1.5 s | 4.6 | 23.6 | n/a | n/a | n/a |
| oracle-local | local | fixture | 36/36 | 36/36 | 0.8 s | 1.9 s | 6.1 | 8.7 | n/a | n/a | n/a |
| null-local | local | all | 0/60 | 0/60 | 0.1 s | 0.3 s | 1.0 | 0.4 | n/a | n/a | n/a |
| null-local | local | public | 0/24 | 0/24 | 0.3 s | 0.7 s | 1.0 | 0.4 | n/a | n/a | n/a |
| null-local | local | fixture | 0/36 | 0/36 | 0.1 s | 0.1 s | 1.0 | 0.4 | n/a | n/a | n/a |

| Task | Tier | oracle-local | null-local |
|---|---|---|---|
| pub-form-multifield | public | 0/3, 0.5 s, 3.0 calls | 0/3, 0.2 s, 1.0 calls |
| pub-wiki-search-extract | public | 3/3, 1.0 s, 4.0 calls | 0/3, 0.3 s, 1.0 calls |
| pub-wiki-multihop | public | 3/3, 0.6 s, 4.0 calls | 0/3, 0.3 s, 1.0 calls |
| pub-books-pagination | public | 3/3, 0.9 s, 8.0 calls | 0/3, 0.2 s, 1.0 calls |
| pub-quotes-infinite-scroll | public | 3/3, 1.3 s, 4.0 calls | 0/3, 0.3 s, 1.0 calls |
| pub-js-prompt | public | 3/3, 0.3 s, 3.0 calls | 0/3, 0.1 s, 1.0 calls |
| pub-shadow-switch | public | 3/3, 0.7 s, 5.7 calls | 0/3, 0.3 s, 1.0 calls |
| pub-iframe-datepicker | public | 3/3, 1.2 s, 5.0 calls | 0/3, 0.2 s, 1.0 calls |
| fx-shadow-nested | fixture | 3/3, 0.8 s, 4.0 calls | 0/3, 0.1 s, 1.0 calls |
| fx-iframe-decoy | fixture | 3/3, 1.5 s, 4.0 calls | 0/3, 0.1 s, 1.0 calls |
| fx-dialog-chain | fixture | 3/3, 0.3 s, 3.0 calls | 0/3, 0.1 s, 1.0 calls |
| fx-file-download | fixture | 3/3, 0.8 s, 3.0 calls | 0/3, 0.1 s, 1.0 calls |
| fx-new-tab-code | fixture | 3/3, 0.9 s, 10.0 calls | 0/3, 0.1 s, 1.0 calls |
| fx-infinite-scroll-select | fixture | 3/3, 0.8 s, 12.7 calls | 0/3, 0.1 s, 1.0 calls |
| fx-paginate-max | fixture | 3/3, 0.9 s, 9.0 calls | 0/3, 0.1 s, 1.0 calls |
| fx-flaky-overlay | fixture | 3/3, 2.0 s, 6.0 calls | 0/3, 0.1 s, 1.0 calls |
| fx-combobox-virtual | fixture | 3/3, 0.8 s, 5.0 calls | 0/3, 0.1 s, 1.0 calls |
| fx-canvas-click | fixture | 3/3, 0.2 s, 3.0 calls | 0/3, 0.1 s, 1.0 calls |
| fx-wizard-validation | fixture | 3/3, 1.9 s, 12.0 calls | 0/3, 0.1 s, 1.0 calls |
| fx-drag-reorder | fixture | 3/3, 0.2 s, 2.0 calls | 0/3, 0.1 s, 1.0 calls |
