module Publishable
  extend ActiveSupport::Concern

  class_methods do
    def recent
      order(:created_at)
    end
  end

  def publish!
    update!(published: true)
  end
end
