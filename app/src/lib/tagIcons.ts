/**
 * スレッドのタグに付けられる Lucide アイコン。Lucide 全体を読み込まないよう、よく使いそうなものだけを
 * 名前 → コンポーネントの対応表にしている（選択肢もここから出す）。表にない名前は `tag` の絵で代用する。
 */
import type { Component } from 'svelte';
import ITag from '@lucide/svelte/icons/tag';
import IStar from '@lucide/svelte/icons/star';
import IHeart from '@lucide/svelte/icons/heart';
import IBookmark from '@lucide/svelte/icons/bookmark';
import IFlag from '@lucide/svelte/icons/flag';
import IPin from '@lucide/svelte/icons/pin';
import ICalendar from '@lucide/svelte/icons/calendar';
import IClock from '@lucide/svelte/icons/clock';
import IBell from '@lucide/svelte/icons/bell';
import ILightbulb from '@lucide/svelte/icons/lightbulb';
import IBug from '@lucide/svelte/icons/bug';
import IWrench from '@lucide/svelte/icons/wrench';
import IHammer from '@lucide/svelte/icons/hammer';
import ICode from '@lucide/svelte/icons/code';
import IBook from '@lucide/svelte/icons/book';
import IBookOpen from '@lucide/svelte/icons/book-open';
import IFileText from '@lucide/svelte/icons/file-text';
import IImage from '@lucide/svelte/icons/image';
import IMusic from '@lucide/svelte/icons/music';
import IFilm from '@lucide/svelte/icons/film';
import IGamepad2 from '@lucide/svelte/icons/gamepad-2';
import IUtensils from '@lucide/svelte/icons/utensils';
import ICoffee from '@lucide/svelte/icons/coffee';
import IShoppingCart from '@lucide/svelte/icons/shopping-cart';
import IHouse from '@lucide/svelte/icons/house';
import ICar from '@lucide/svelte/icons/car';
import IPlane from '@lucide/svelte/icons/plane';
import IMapPin from '@lucide/svelte/icons/map-pin';
import IGift from '@lucide/svelte/icons/gift';
import IPartyPopper from '@lucide/svelte/icons/party-popper';
import ITrophy from '@lucide/svelte/icons/trophy';
import ICircleQuestionMark from '@lucide/svelte/icons/circle-question-mark';
import ICircleAlert from '@lucide/svelte/icons/circle-alert';
import ICircleCheck from '@lucide/svelte/icons/circle-check';
import IZap from '@lucide/svelte/icons/zap';
import IFlame from '@lucide/svelte/icons/flame';
import ISun from '@lucide/svelte/icons/sun';
import IMoon from '@lucide/svelte/icons/moon';
import IUsers from '@lucide/svelte/icons/users';
import IBriefcase from '@lucide/svelte/icons/briefcase';
import IGraduationCap from '@lucide/svelte/icons/graduation-cap';
import ICamera from '@lucide/svelte/icons/camera';

type IconComponent = Component<{ size?: number; class?: string }>;

export const TAG_ICONS: Record<string, IconComponent> = {
  tag: ITag,
  star: IStar,
  heart: IHeart,
  bookmark: IBookmark,
  flag: IFlag,
  pin: IPin,
  calendar: ICalendar,
  clock: IClock,
  bell: IBell,
  lightbulb: ILightbulb,
  bug: IBug,
  wrench: IWrench,
  hammer: IHammer,
  code: ICode,
  book: IBook,
  'book-open': IBookOpen,
  'file-text': IFileText,
  image: IImage,
  music: IMusic,
  film: IFilm,
  'gamepad-2': IGamepad2,
  utensils: IUtensils,
  coffee: ICoffee,
  'shopping-cart': IShoppingCart,
  house: IHouse,
  car: ICar,
  plane: IPlane,
  'map-pin': IMapPin,
  gift: IGift,
  'party-popper': IPartyPopper,
  trophy: ITrophy,
  'circle-question-mark': ICircleQuestionMark,
  'circle-alert': ICircleAlert,
  'circle-check': ICircleCheck,
  zap: IZap,
  flame: IFlame,
  sun: ISun,
  moon: IMoon,
  users: IUsers,
  briefcase: IBriefcase,
  'graduation-cap': IGraduationCap,
  camera: ICamera,
};

/** 選択肢に出す名前（表の順） */
export const TAG_ICON_NAMES = Object.keys(TAG_ICONS);

/** 名前からアイコンを引く。表にない名前は代用の絵 */
export function tagIcon(name: string): IconComponent {
  return TAG_ICONS[name] ?? TAG_ICONS.tag;
}
