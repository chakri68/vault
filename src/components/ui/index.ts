// Almirah primitives. Every screen is built from these; see ui_theme.md → Components.
export { cn, type ClassValue } from "./cn";
export { Icon, type LucideIcon } from "./icon";
export {
  CATEGORIES,
  DEFAULT_CATEGORY_IDS,
  AVATAR_TINTS,
  categoryInfo,
  type CategoryInfo,
  type CatTint,
  type DefaultCategoryId,
} from "./categories";

// layout
export { Group, GroupLabel, Row, KeyValueRow, type GroupProps, type GroupLabelProps, type RowProps, type KeyValueRowProps } from "./group";
export {
  Screen,
  ScreenHeader,
  Section,
  TopBar,
  BottomBar,
  type ScreenProps,
  type ScreenHeaderProps,
  type TopBarProps,
  type BottomBarProps,
  type BottomBarTab,
} from "./layout";

// actions
export { Button, IconButton, Spinner, type ButtonProps, type ButtonVariant, type ButtonSize, type IconButtonProps } from "./button";

// inputs
export {
  Field,
  TextInput,
  PasswordField,
  MonoInput,
  SearchField,
  type FieldProps,
  type TextInputProps,
  type PasswordFieldProps,
  type MonoInputProps,
  type SearchFieldProps,
} from "./field";
export {
  Chip,
  ChipRow,
  SegmentedControl,
  type ChipProps,
  type ChipRowProps,
  type SegmentedControlProps,
  type SegmentedOption,
} from "./chip";
export { Switch } from "./switch";

// feedback
export {
  Banner,
  ProgressBar,
  StatusPill,
  MetaPill,
  Availability,
  Skeleton,
  SkeletonRow,
  SkeletonRows,
  type BannerProps,
  type BannerAction,
  type BannerTone,
  type ProgressBarProps,
  type StatusPillProps,
  type StatusTone,
  type AvailabilityProps,
} from "./feedback";
export { ToastProvider, useToast, type ToastOptions, type ToastAction } from "./toast";

// overlays
export { Sheet, ConfirmDialog, type SheetProps, type ConfirmDialogProps } from "./overlay";

// display
export { Tile, Avatar, type TileProps, type AvatarProps } from "./tile";
export {
  AppMark,
  AlmirahGlyph,
  CategoryTile,
  CategoryGrid,
  EmptyState,
  StepProgress,
  RecoveryCodeGrid,
  type AppMarkProps,
  type CategoryTileProps,
  type EmptyStateProps,
  type StepProgressProps,
  type RecoveryCodeGridProps,
} from "./display";
