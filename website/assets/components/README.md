# Product component previews

The product previews are native HTML/CSS, defined in `components.js` and styled
in `styles.css`. Screenshot assets have been replaced so text stays selectable,
accessible and clear at different sizes.

The components follow the project's output-first interface: a prepared reply,
product brief, verified document, and task cards for decisions, background work
and external waits. English and Chinese versions share the same structure.
The header language control switches page copy and all previews together.
No language preference is saved to browser storage.

Reply editing, evidence expansion and text downloads run locally in the browser.
Approving a reply demonstrates the state change and reports that no email was
sent. Names and example content are fictional. These previews do not connect
to accounts or perform actions on live provider services.

For the intended behavior of the implemented interface, see the
[workspace design documentation](https://github.com/PStarH/unprompted/blob/main/docs/UI_DESIGN.md).
