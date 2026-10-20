import type { Rule, Session } from '../electron/types.js';
export const NOW = Date.UTC(2099, 0, 1);
export const rule: Rule = {
  id: 'rule-1',
  revision: 1,
  provider: 'megabox',
  theaterId: '1372',
  theaterName: '코엑스',
  movieTitle: '별의 영화',
  date: '2099-01-01',
  format: '2D',
  isEnabled: true,
};
export const session: Session = {
  provider: 'megabox',
  showingId: 'schedule-a',
  theaterId: '1372',
  theaterName: '코엑스',
  movieId: 'movie-1',
  movieTitle: '별의 영화',
  date: '2099-01-01',
  time: '15:30',
  screen: '1관',
  format: '2D',
  isBookable: true,
  bookingUrl: 'https://www.megabox.co.kr/booking',
};
export const megabox = {
  statCd: 0,
  movieFormList: [
    {
      playSchdlNo: 'schedule-a',
      brchNo: '1372',
      brchNm: '코엑스',
      movieNo: 'movie-1',
      movieNm: '별의 영화',
      playDe: '20990101',
      playStartTime: '1530',
      theabExpoNm: '1관',
      playKindNm: '2D&#40;자막&#41;',
      restSeatCnt: 5,
      bokdAbleAt: 'Y',
      brchBokdUnableAt: 'N',
    },
  ],
};
export const cgv = {
  statusCode: 0,
  data: [
    {
      siteNo: '0056',
      siteNm: 'CGV 극장',
      scnYmd: '20990101',
      scnSseq: '1',
      movNo: 'movie-1',
      movNm: '별의 영화',
      scnsrtTm: '1530',
      scnsNm: '1관',
      scnFmtNm: 'IMAX',
      frSeatCnt: 3,
      sellYn: 'Y',
    },
  ],
};
export const lotte = {
  IsOK: true,
  PlaySeqs: {
    Items: [
      {
        CinemaID: '1016',
        CinemaNameKR: '월드타워',
        RepresentationMovieCode: 'movie-1',
        MovieNameKR: '별의 영화',
        ScreenID: '1',
        ScreenNameKR: '1관',
        PlaySequence: '3',
        PlayDt: '2099-01-01',
        StartTime: '15:30',
        FilmNameKR: '2D',
        ScreenDivisionNameKR: '일반',
        BookingSeatCount: 10,
        IsBookingYN: 'Y',
      },
    ],
  },
};
