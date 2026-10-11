class UserTest < ActiveSupport::TestCase
  test "activates" do
    users(:one).activate!
  end
end
