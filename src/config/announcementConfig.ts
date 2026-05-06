import type { AnnouncementConfig } from "../types/config";

export const announcementConfig: AnnouncementConfig = {
	// 公告标题
	title: "公告",

	// 公告内容
	content: "BLOG V1.1公告须知",

	// 是否允许用户关闭公告
	closable: false,

	link: {
		// 启用链接
		enable: true,
		// 链接文本
		text: "查看更多",
		// 链接 URL
		url: "/about/",
		// 内部链接
		external: false,
	},
};
