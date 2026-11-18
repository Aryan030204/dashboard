Fonts installed into the worker image so LibreOffice renders slides with the real fonts instead of substitutes.
The worker image copies this folder into the system font directory and `../fontconfig/` into `/etc/fonts/conf.d/`.

Included (all SIL Open Font License 1.1; the licence texts are the `OFL-*.txt` files here):

- Bebas Neue (Regular) - the headings; decks name it "Bebas Neue Cyrillic"
- Poppins (Regular, Medium, SemiBold, Bold) - body text
- Alexandria (variable weight)
- Inter (variable weight and optical size)

Add other brand fonts (.ttf / .otf) here, and a rule in `../fontconfig/60-deck-fonts.conf` if a deck uses a name that differs from the
font's own family name. Only add fonts you are licensed to embed on a server. After a rebuild the worker logs which deck fonts it
found (`deck fonts installed?`) at start-up.
