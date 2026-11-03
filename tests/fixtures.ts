// SYNTHETIC fixtures. Shapes mirror live Workvivo responses captured
// 2026-11-03 (field names, nesting, timestamp formats); every value — names,
// emails, ids, text — is invented. Never paste a captured response here.

export const alice = {
  id: 101,
  full_name: 'Alice Example',
  display_name: 'Alice',
  first_name: 'Alice',
  last_name: 'Example',
  email: 'alice@example.com',
  job_title: 'Engineer',
  department_name: 'Engineering',
  location_name: 'Remote',
  cost_centre_name: 'CC-1',
  is_alumni: false,
  is_external: 0,
  avatar_url: 'https://cdn.example.com/a.png',
  relative_permalink: 'directory/people/101',
};

export const bob = { ...alice, id: 102, full_name: 'Bob Sample', email: 'bob@example.com', job_title: 'Designer' };

export const updateActivity = {
  id: 9001,
  user_id: 101,
  item_type: 'update',
  item_id: 5001,
  created_at: '2026-11-03 14:15:54',
  pinned_at: null,
  spaces: [],
  item: {
    id: 5001,
    text: 'Proud of the team this week.\n\nThanks all!',
    html: '<p>Proud of the team this week.</p><p>Thanks all!</p>',
    comments_count: 2,
    likes_count: 7,
    creator: alice,
    relative_permalink: 'comments/update/5001',
  },
};

export const articleActivity = {
  id: 9002,
  item_type: 'article',
  item_id: 7001,
  created_at: '2026-10-27 14:15:00',
  pinned_at: '2026-10-27 15:00:00',
  spaces: [{ id: 30, name: 'Company News' }],
  item: {
    id: 7001,
    title: 'Quarterly update',
    subtitle: 'What we shipped',
    short_text: '...',
    comments_count: 0,
    likes_count: 3,
    creator: { id: 900, full_name: 'Comms Team' },
    relative_permalink: 'news/7001',
  },
};

export const eventActivity = {
  id: 9003,
  item_type: 'event',
  item_id: 8001,
  created_at: '2026-10-20 10:00:00',
  spaces: [{ id: 30, name: 'Company News' }],
  item: {
    id: 8001,
    title: 'Town Hall',
    text: 'Join us.',
    scheduled_at: '2026-11-11 18:00:00',
    user: { id: 900, full_name: 'Comms Team' },
    comments_count: 1,
    relative_permalink: 'events/8001',
  },
};

export const kudosActivity = {
  id: 9004,
  item_type: 'kudos',
  item_id: 6001,
  created_at: '2026-11-02 09:00:00',
  spaces: [],
  item: {
    id: 6001,
    text: 'Thanks Bob for the help!',
    giver: alice,
    user_mentions: [{ user: bob }],
    comments_count: 0,
    likes_count: 1,
    relative_permalink: 'comments/kudos/6001',
  },
};

export const feed = {
  next_cursor: 'eyJjdXJzb3IiOjF9',
  next_page_url: `https://acme.workvivo.us/api/activity?next_cursor=eyJjdXJzb3IiOjF9`,
  per_page: 5,
  pins: [],
  subscriptions: [],
  data: [updateActivity, articleActivity, eventActivity, kudosActivity],
};

export const articleList = {
  current_page: 1,
  data: [
    {
      id: 7001,
      title: 'Quarterly update',
      subtitle: 'What we shipped',
      published_at: '2026-10-27 14:15:00',
      creator: { id: 900, full_name: 'Comms Team' },
      comments_count: 4,
      likes_count: 9,
      spaces: [{ id: 30, name: 'Company News' }],
      image_url: 'https://cdn.example.com/hero.jpg',
    },
  ],
  links: { next: 'https://acme.workvivo.us/api/articles?page=2' },
  meta: { current_page: 1, per_page: 5 },
  next_page_url: 'https://acme.workvivo.us/api/articles?page=2',
};

export const article = {
  ...articleList.data[0],
  permalink: 'https://acme.workvivo.us/news/7001',
  html_content: '<h2>Highlights</h2><p>We shipped <strong>three</strong> things.</p><ul><li>One</li><li>Two</li></ul>',
  language_variants: [{ lang: 'fr', html_content: '<p>…</p>' }],
};

export const event = {
  id: 8001,
  title: 'Town Hall',
  scheduled_at: '2026-11-11 18:00:00',
  scheduled_at_utc: '2026-11-11T18:00:00Z',
  ends_at: '2026-11-11 18:30:00',
  ends_at_utc: '2026-11-11T18:30:00Z',
  all_day_event: false,
  location: 'Virtual',
  going_count: 12,
  is_going: true,
  user: { id: 900, full_name: 'Comms Team' },
  spaces: [{ id: 30, name: 'Company News' }],
  text: 'Quarterly all-hands. Bring questions.',
  book_button_url: 'https://example.com/rsvp',
  zoom_webinar_id: '123',
  zoom_webinar_password: 'hunter2-synthetic',
  zoom_webinar_url: 'https://zoom.example.com/j/123',
};

export const comments = [
  { id: 1, parent_comment_id: null, user_id: 101, created_at: '2026-10-20 18:03:06', text: 'Great news', likes_count: 3 },
  { id: 2, parent_comment_id: 1, user_id: 102, created_at: '2026-10-21 09:00:00', text: 'Agreed', likes_count: 0 },
  { id: 3, parent_comment_id: null, user_id: 103, created_at: '2026-10-22 09:00:00', text: 'Where do I sign up?', likes_count: 0 },
];

export const personDetail = {
  ...alice,
  formatted_hire_date: 'December 2021',
  manager: { id: 102, full_name: 'Bob Sample' },
  manages: [{ id: 104 }, { id: 105 }],
  profile: { short_bio: 'Builds things.', expertise: 'TypeScript', interests: 'Climbing' },
  followers_count: '62',
  following_count: 10,
  mobile_phone: '+1 555 0100',
  birthday: '1990-01-01',
};

export const me = {
  ...alice,
  timezone: 'America/New_York',
  locale: 'en',
  allRoles: ['employee'],
  realtimeEventsToken: { token: 'rt-synthetic' },
  amplitude_key: 'amp-synthetic',
  organisation: { name: 'Acme', settings: { big: true } },
};

export const spaceList = {
  current_page: 1,
  data: [
    {
      id: 30,
      name: 'Company News',
      description: 'Your trusted source for updates.',
      members_count: 18000,
      is_member: true,
      is_official: true,
      private: false,
      parent_space_id: null,
      relative_permalink: 'spaces/30',
    },
  ],
  next_page_url: null,
};

export const notifications = {
  current_page: 1,
  data: [
    {
      id: 'a322aa6a-0000-0000-0000-000000000000',
      type: 'App\\Notifications\\ArticlePublishedNotification',
      read_at: null,
      created_at: '2026-11-03 08:00:33',
      data: { id: 7001, type: 'news', title: 'Quarterly update' },
    },
  ],
  next_page_url: null,
};

export const searchResults = {
  current_page: 1,
  last_page: 3,
  search_history_id: 1,
  errors: [],
  data: [
    {
      id: '7001',
      type: 'article',
      title: 'Quarterly <strong>update</strong>',
      url: 'news/7001',
      score: 12.3,
      updated_at: '2026-10-19T21:08:20.000000Z',
      details: { author: 'Comms Team', text: 'We shipped <strong>three</strong> things' },
    },
  ],
};

export const questionPost = {
  id: 4001,
  title: 'Our mission',
  body: '<p>What is the club mission?</p>',
  created_at: '2025-08-09 02:05:19',
  user: alice,
  answered: true,
  answers_count: 2,
  accepted_answer: { id: 4101 },
  votes: 3,
  views_count: 40,
  spaces: [{ id: 31, name: 'Speakers Club' }],
  relative_permalink: 'spaces/31/questions/4001',
};

export const answers = {
  current_page: 1,
  next_page_url: 'https://acme.workvivo.us/api/question-posts/4001/answers?page=2',
  data: [
    { id: 4101, question_post_id: 4001, body: '<p>To help people <strong>grow</strong>.</p>', accepted: true, votes: 2, comments_count: 0, created_at: '2025-08-10 09:00:00', user: bob },
    { id: 4102, question_post_id: 4001, body: '<p>Practice.</p>', accepted: false, votes: 0, comments_count: 1, created_at: '2025-08-11 09:00:00', user: alice },
  ],
};
