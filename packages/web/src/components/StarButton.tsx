import { useFavorites } from "../lib/favorites";
import { useT } from "../lib/i18n";

/**
 * 收藏星标：卡片上只有图标，详情页带文字。
 *
 * 卡片整张被标题链接的伪元素盖住，按钮必须 stopPropagation + preventDefault，
 * 否则点星标会顺手跳到详情页。
 */
export function StarButton({ id, withLabel = false }: { id: string; withLabel?: boolean }) {
  const { has, toggle } = useFavorites();
  const { t } = useT();
  const on = has(id);
  const label = on ? t("fav.saved") : t("fav.save");

  return (
    <button
      type="button"
      className={`star-btn${on ? " is-on" : ""}${withLabel ? " has-label" : ""}`}
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle(id);
      }}
    >
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
        <path
          d="M12 3.4l2.65 5.37 5.93.86-4.29 4.18 1.01 5.9L12 16.92l-5.3 2.79 1.01-5.9L3.42 9.63l5.93-.86z"
          fill={on ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
      {withLabel && <span>{label}</span>}
    </button>
  );
}
