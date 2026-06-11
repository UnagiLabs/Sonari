/** ボトムシートの開閉状態 */
export type SheetState = "collapsed" | "expanded";

/** シートの初期状態（折りたたみ） */
export const initialSheetState: SheetState = "collapsed";

/**
 * シートの開閉をトグルする。
 * 引数を変更せず新しい状態を返す（immutable）。
 */
export function toggleSheet(state: SheetState): SheetState {
    return state === "collapsed" ? "expanded" : "collapsed";
}

/**
 * セル選択が発生した際のシート状態を返す。
 * collapsed なら expanded へ、既に expanded ならそのまま。
 * 引数を変更せず新しい状態を返す（immutable）。
 */
export function sheetStateAfterSelection(state: SheetState): SheetState {
    return "expanded";
}
