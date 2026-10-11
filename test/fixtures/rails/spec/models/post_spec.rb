RSpec.describe Post do
  let(:post) { create(:post) }
  let(:author) { User.new }

  it "publishes" do
    post.publish!
    author.activate!
  end

  it "has a published scope" do
    described_class.published
  end
end
