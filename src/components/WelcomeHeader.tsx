export function WelcomeHeader() {
  return (
    <section className="welcome" aria-labelledby="welcome-title">
      <p className="eyebrow"><span>王星</span>，你好 <span className="wave" aria-hidden="true">👋</span></p>
      <h1 id="welcome-title">今天需要分析哪段客户对话？</h1>
      <p className="welcome-copy">上传客户聊天截图或粘贴完整对话，AI将结合企业销售规则和已审核资料，提供销管判断及回复建议。</p>
    </section>
  );
}
