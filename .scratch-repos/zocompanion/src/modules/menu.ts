import { getString } from "../utils/locale";

export function registerItemMenu(): void {
  const menuIcon = `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`;
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: `${addon.data.config.addonRef}-itemmenu-ping`,
    label: getString("menuitem-label"),
    commandListener: () => {
      const pane = Zotero.getActiveZoteroPane();
      const items = pane.getSelectedItems();
      const titles = items
        .filter((item) => item.isRegularItem())
        .map((item) => String(item.getField("title") || "(untitled)"));
      const text = titles.length
        ? titles.join("\n")
        : "(no regular item selected)";
      ztoolkit.log("Selected items:", titles);
      const win = Zotero.getMainWindow();
      if (win) {
        Zotero.alert(win, addon.data.config.addonName, text);
      }
    },
    icon: menuIcon,
  });
}
