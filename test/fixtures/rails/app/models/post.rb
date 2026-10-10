class Post < ApplicationRecord
  include Publishable

  belongs_to :author, class_name: "User"
  has_many :comments

  scope :published, -> { where(published: true).tap { |r| r.load } }

  before_save :normalize_title

  def view!
    increment!(:views)
  end

  private

  def normalize_title
    self.title = title.strip
  end
end
